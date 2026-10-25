import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import type { EditApplyResult, ProposalDto } from "../protocol";
import type { DiffAdapter } from "./diffAdapter";
import type { createEditAdapter } from "./editAdapter";

type EditAdapter = ReturnType<typeof createEditAdapter>;

/** Text cache caps: entry count and total bytes (LRU eviction). No TTL — invalidation comes from upsert events, not from time */
const TEXT_CACHE_MAX_ENTRIES = 3;
const TEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Staging and applying proposals (virtual files).
 *
 * Model (README §10):
 *   1. The core supplies the "full corrected file content" but **never touches disk**; it only emits a `proposal.changed` metadata event
 *   2. The user clicks "View" → the shell calls `proposal.read` to fetch the body → real file on the left / virtual file on the right, shown by `vscode.diff`
 *   3. The user clicks "Accept" → the shell writes it in one shot via `edit.apply` → only on success does it notify the core with `proposal.decide(accept)`
 *   4. The user clicks "Reject" → nothing is written; the core is notified directly with `proposal.decide(reject)`
 *
 * The order is what matters: **write to disk first, tell the core afterwards**. Reversed, you get "the core thinks it was applied but the disk never changed".
 */
export class ProposalAdapter implements vscode.Disposable {
  private readonly byId = new Map<string, ProposalDto>();
  /** Cache of bodies already viewed: avoids pulling the same large file twice on "view → accept" (LRU, with capacity caps) */
  private readonly textCache = new Map<string, { text: string; bytes: number }>();
  private textCacheBytes = 0;
  private disposed = false;
  private readonly idleWaiters: Array<{ resolve: () => void; reject: (err: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(
    private readonly diff: DiffAdapter,
    private readonly edit: EditAdapter,
    private readonly logger: Logger,
  ) {}

  /**
   * Register/update a proposal.
   *
   * **Deduplicate by path**: a file should have only one valid proposal. When a new proposal arrives, any other
   * still-pending proposal for that path is marked stale — otherwise the user might accept the old one first
   * and overwrite the new content with the old.
   */
  upsert(dto: ProposalDto): void {
    for (const [id, existing] of this.byId) {
      if (id !== dto.id && existing.path === dto.path && existing.status === "pending") {
        this.byId.set(id, {
          ...existing,
          status: "stale",
          summary: existing.summary ?? "Replaced by a newer proposal for the same file",
        });
        this.logger.debug(`proposal ${id} replaced by newer proposal ${dto.id} for the same path (marked stale)`);
      }
    }
    // Option A: body changes cannot be observed from metadata, so any upsert is treated as possibly changed → drop the cache
    this.forgetText(dto.id);
    this.byId.set(dto.id, dto);
  }

  remove(id: string): void {
    this.byId.delete(id);
    this.notifyIdle();
  }

  get(id: string): ProposalDto | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.byId.clear();
    this.textCache.clear();
    this.textCacheBytes = 0;
    this.notifyIdle();
  }

  /** A write-capable command may have changed any file: pending proposals are no longer safe to apply. */
  markPendingStale(reason: string): void {
    for (const [id, dto] of this.byId) {
      if (dto.status !== "pending") continue;
      this.byId.set(id, { ...dto, status: "stale", summary: dto.summary ?? reason });
    }
    this.notifyIdle();
  }

  /** The file was modified after the proposal was generated → mark it stale; the UI then prompts to "regenerate" */
  markStale(id: string): void {
    const dto = this.byId.get(id);
    if (dto) {
      this.byId.set(id, { ...dto, status: "stale" });
      this.notifyIdle();
    }
  }

  /** All proposals the panel should show: pending + stale (stale ones must stay visible, or they "vanish into thin air") */
  visible(): ProposalDto[] {
    return [...this.byId.values()]
      .filter((p) => p.status === "pending" || p.status === "stale")
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Proposals genuinely awaiting a decision (stale ones don't count; they can only be regenerated) */
  pending(): ProposalDto[] {
    return this.visible().filter((p) => p.status === "pending");
  }

  count(): number {
    return this.pending().length;
  }

  /** Open the proposal diff (left = current disk state, right = proposed content). The body is fetched on demand and is not kept resident in memory. */
  async show(id: string, fetchText: (id: string) => Promise<string>): Promise<boolean> {
    const dto = this.byId.get(id);
    if (!dto) return false;
    let text: string;
    try {
      text = await fetchText(id);
    } catch (err) {
      this.logger.warn(`Failed to read proposal body ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.rememberText(id, text);
    const result = await this.diff.openProposal({ path: dto.path, text, title: dto.summary });
    return result.opened;
  }

  /**
   * Accept a proposal: fetch the body → write to disk → notify the core only on success.
   *
   * On failure (version conflict / locked / path rejected) the state is left untouched and the proposal stays,
   * so the user can look again and decide — never "the core believes it was accepted while the file did not change".
   */
  async accept(
    id: string,
    fetchText: (id: string) => Promise<string>,
    decide: (id: string, decision: "accept" | "reject") => Promise<void>,
  ): Promise<EditApplyResult> {
    const dto = this.byId.get(id);
    if (!dto) return { applied: false, message: "Proposal not found (it may have been withdrawn by the core)" };

    if (dto.baseVersion === undefined) {
      // Without baseVersion there is no conflict detection — log a warn so it does not silently become an "unconditional overwrite"
      this.logger.warn(`proposal ${id} has no baseVersion; accepting it will skip version-conflict detection (it may overwrite the user's recent edits)`);
    }

    let text = this.takeText(id);
    if (text === undefined) {
      try {
        text = await fetchText(id);
      } catch (err) {
        return { applied: false, message: `Failed to read proposal body: ${err instanceof Error ? err.message : String(err)}` };
      }
      // A failed write can be retried, without fetching again
      this.rememberText(id, text);
    }

    const result = await this.edit.apply(
      {
        path: dto.path,
        newText: text,
        expectedVersion: dto.baseVersion,
        reason: dto.summary,
      },
      syntheticContext(),
    );

    if (!result.applied) return result;

    await this.diff.closeProposal(dto.path);
    this.byId.delete(id);
    this.forgetText(id);
    this.notifyIdle();
    await decide(id, "accept").catch((err: unknown) => {
      this.logger.warn(`proposal.decide(accept) failed ${id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return result;
  }

  /** Reject: not a single byte on disk changes; the core is merely told to drop the proposal */
  async reject(
    id: string,
    decide: (id: string, decision: "accept" | "reject") => Promise<void>,
  ): Promise<void> {
    const dto = this.byId.get(id);
    if (!dto) return;
    await this.diff.closeProposal(dto.path);
    this.byId.delete(id);
    this.forgetText(id);
    this.notifyIdle();
    await decide(id, "reject").catch((err: unknown) => {
      this.logger.warn(`proposal.decide(reject) failed ${id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Wait until every pending proposal has been accepted, rejected, or removed. */
  waitForIdle(signal?: AbortSignal): Promise<void> {
    if (this.pending().length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          if (waiter.onAbort) signal?.removeEventListener("abort", waiter.onAbort);
          resolve();
        },
        reject: (err: Error) => {
          if (waiter.onAbort) signal?.removeEventListener("abort", waiter.onAbort);
          reject(err);
        },
        signal,
        onAbort: undefined as (() => void) | undefined,
      };
      if (signal) {
        waiter.onAbort = () => {
          this.idleWaiters.splice(this.idleWaiters.indexOf(waiter), 1);
          reject(new Error("cancelled while waiting for proposal decisions"));
        };
        if (signal.aborted) {
          waiter.onAbort();
          return;
        }
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.idleWaiters.push(waiter);
    });
  }

  private notifyIdle(): void {
    if (this.pending().length > 0) return;
    for (const waiter of this.idleWaiters.splice(0)) waiter.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.byId.clear();
    this.textCache.clear();
    this.textCacheBytes = 0;
  }

  // ───────────────────────── Body cache (LRU + byte cap) ─────────────────────────

  private rememberText(id: string, text: string): void {
    this.forgetText(id);
    const bytes = Buffer.byteLength(text, "utf8");
    this.textCache.set(id, { text, bytes });
    this.textCacheBytes += bytes;
    this.evictTextCache();
  }

  /** Taking an entry refreshes its LRU position; undefined means it was not cached */
  private takeText(id: string): string | undefined {
    const hit = this.textCache.get(id);
    if (!hit) return undefined;
    this.textCache.delete(id);
    this.textCache.set(id, hit);
    return hit.text;
  }

  private forgetText(id: string): void {
    const hit = this.textCache.get(id);
    if (!hit) return;
    this.textCacheBytes -= hit.bytes;
    this.textCache.delete(id);
  }

  private evictTextCache(): void {
    while (this.textCache.size > TEXT_CACHE_MAX_ENTRIES || this.textCacheBytes > TEXT_CACHE_MAX_BYTES) {
      const oldest = this.textCache.keys().next().value;
      if (!oldest) break;
      this.forgetText(oldest);
    }
  }
}

/** The ctx the adapters want only exists in RPC scenarios; local triggers get an empty one (no cancellation semantics) */
function syntheticContext(): InboundRequestContext {
  return {
    id: "local",
    signal: new AbortController().signal,
    throwIfCancelled() {
      /* local actions are not cancellable */
    },
  };
}
