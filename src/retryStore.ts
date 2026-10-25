import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";

export type RetryStatus = "waiting" | "starting" | "done" | "failed" | "cancelled";

/** One persistable model-retry event; append-only and not projected into chat messages. */
export interface RetryEvent {
  ts: number;
  sessionId: string;
  status: RetryStatus;
  attempt?: number;
  max?: number;
  delayMs?: number;
  reason?: string;
}

/** The most recent request that has not been confirmed complete; used to restore "retry this turn" after a reload. */
export interface PendingTurn {
  sessionId: string;
  text: string;
  mode: string;
  attachments: unknown[];
  savedAt: number;
}

/**
 * Persistence for model-retry events / pending requests.
 *
 * Storage:
 *   <sessions>/<sessionId>.retries.jsonl   one event per line, append-only
 *   <sessions>/<sessionId>.pending.json    the latest incomplete request (atomically overwritten)
 *
 * A retry event is written before waiting for the backoff; if the process crashes while waiting, a
 * reload still shows the last status as waiting/starting instead of mistaking "retrying right now" for
 * something that never happened.
 */
export class RetryStore {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  /** Append a retry event; a failure is only logged and does not affect the main flow. */
  async append(event: RetryEvent): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.appendFile(this.fileOf(event.sessionId), `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      this.logger.warn(`重试事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Synchronous append: used from the notification thread so the event is on disk before returning. */
  appendSync(event: RetryEvent): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.fileOf(event.sessionId), `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      this.logger.warn(`重试事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Read all retry events of a session (bad lines are skipped). */
  async load(sessionId: string): Promise<RetryEvent[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.fileOf(sessionId), "utf8");
    } catch {
      return [];
    }
    const out: RetryEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as RetryEvent;
        if (typeof parsed.status === "string" && typeof parsed.ts === "number") out.push(parsed);
      } catch {
        // A partial line left by a crash: ignore
      }
    }
    return out;
  }

  async latest(sessionId: string): Promise<RetryEvent | undefined> {
    const events = await this.load(sessionId);
    return events[events.length - 1];
  }

  /** Save the most recent request; write to disk before calling the model. */
  async savePending(pending: PendingTurn): Promise<void> {
    const file = this.pendingFileOf(pending.sessionId);
    const tmp = `${file}.tmp`;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(pending), "utf8");
      await fs.promises.rename(tmp, file);
    } catch (err) {
      this.logger.warn(`待重试请求写入失败: ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async loadPending(sessionId: string): Promise<PendingTurn | undefined> {
    try {
      const raw = await fs.promises.readFile(this.pendingFileOf(sessionId), "utf8");
      const parsed = JSON.parse(raw) as PendingTurn;
      if (typeof parsed.text !== "string" || typeof parsed.mode !== "string") return undefined;
      return { ...parsed, attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [] };
    } catch {
      return undefined;
    }
  }

  async clearPending(sessionId: string): Promise<void> {
    await fs.promises.rm(this.pendingFileOf(sessionId), { force: true }).catch(() => undefined);
  }

  private fileOf(sessionId: string): string {
    return path.join(this.dir, `${sanitize(sessionId)}.retries.jsonl`);
  }

  private pendingFileOf(sessionId: string): string {
    return path.join(this.dir, `${sanitize(sessionId)}.pending.json`);
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}
