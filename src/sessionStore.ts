import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";
import type { DiagramDto, LastIntentDto, Mode, PlanStep } from "./protocol";

/** One persisted message (append-only, never modified) */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
  /** For review only: reasoning content does not enter the model context and does not join the summary */
  reasoning?: string | ReasoningSegment[];
  /** Diagrams attached to the assistant's answer (Mermaid source; rendered lazily by the frontend after reload) */
  diagrams?: DiagramDto[];
}

/** Reasoning content of one model call (for segmented review) */
export interface ReasoningSegment {
  round: number;
  text: string;
}

export type TurnStatus = "idle" | "thinking" | "tool" | "awaiting-decision";

export interface SessionMeta {
  id: string;
  /** Title: first 40 characters of the first user message */
  title: string;
  mode: Mode;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Which phase it was in at the last crash/reload (see docs §9.3) */
  status?: TurnStatus;
  statusDetail?: string;
  /** Most recent plan (carried across turns + restores the panel after a reload) */
  plan?: PlanStep[];
  /** Intent of the previous turn (carried across turns; still usable after a kernel restart) */
  lastIntent?: LastIntentDto;
}

const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;

/**
 * Session repository: **the full conversation on disk** (append-only JSONL) plus one index.
 *
 * Directory layout (default `<globalStorage>/sessions/`, overridable with `beeCode.session.dir`):
 *
 *   sessions/
 *     index.json                 <- session list (title/time/message count) for fast UI enumeration
 *     <sessionId>.jsonl          <- the full record, one message per line, append-only
 *
 * Why JSONL instead of a single JSON file:
 *   - Appends, so a crash loses at most the last partial line; rewriting the whole file would lose the whole session
 *   - The full history is never truncated (the model context is a different matter: it takes only what is needed, see `contextBuilder.ts`)
 *   - Same shape as Claude Code (`~/.claude/projects/<proj>/<id>.jsonl`) and Codex (`~/.codex/sessions/**`), which eases troubleshooting and migration
 */
export class SessionStore {
  private index: SessionMeta[] | undefined;
  private indexTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    /** Root directory (defaults to the sessions subdirectory of globalStorage) */
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  /** List all sessions (most recently updated first) */
  list(): SessionMeta[] {
    this.ensureIndex();
    return [...(this.index ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  meta(id: string): SessionMeta | undefined {
    this.ensureIndex();
    return this.index?.find((m) => m.id === id);
  }

  /** Read a session's complete messages (bad lines are skipped so one corrupt line cannot take down the whole session) */
  async open(id: string): Promise<StoredMessage[]> {
    const file = this.fileOf(id);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch {
      return [];
    }
    const out: StoredMessage[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as StoredMessage;
        if (typeof parsed.text === "string" && typeof parsed.role === "string") out.push(parsed);
      } catch {
        // A partial line left by a crash: ignore
      }
    }
    return out;
  }

  /** Create a session (only registers the index, no file yet; it is written when the first message arrives) */
  create(meta: Omit<SessionMeta, "messageCount" | "updatedAt">): void {
    this.ensureIndex();
    this.index = (this.index ?? []).filter((m) => m.id !== meta.id);
    this.index.push({ ...meta, messageCount: 0, updatedAt: Date.now() });
    this.scheduleIndexWrite();
  }

  /** Append a message: write the JSONL immediately, update the index with debounce */
  append(id: string, message: StoredMessage): void {
    void this.appendAsync(id, message);
  }

  async appendAsync(id: string, message: StoredMessage): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.appendFile(this.fileOf(id), `${JSON.stringify(message)}\n`, "utf8");
    } catch (err) {
      this.logger.warn(`Failed to write session: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.ensureIndex();
    const entry = this.index?.find((m) => m.id === id);
    if (entry) {
      entry.messageCount += 1;
      entry.updatedAt = Date.now();
      if (message.role === "user" && entry.title === "New session") {
        entry.title = message.text.replace(/\s+/g, " ").trim().slice(0, 40) || "New session";
      }
      this.scheduleIndexWrite();
    }
  }

  /**
   * Truncate the session to the first `messageCount` entries (used to roll back chat history).
   *
   * The JSONL is append-only; truncation rewrites the whole file (write a temp file first, then rename)
   * so that crashing halfway does not corrupt the entire session.
   */
  async truncate(id: string, messageCount: number): Promise<StoredMessage[]> {
    const messages = await this.open(id);
    const kept = messages.slice(0, Math.max(0, Math.floor(messageCount)));
    const file = this.fileOf(id);
    const body = kept.map((m) => JSON.stringify(m)).join("\n") + (kept.length > 0 ? "\n" : "");
    const tmp = `${file}.tmp`;
    try {
      await fs.promises.writeFile(tmp, body, "utf8");
      await fs.promises.rename(tmp, file);
    } catch (err) {
      this.logger.warn(`Failed to truncate session: ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    this.ensureIndex();
    const entry = this.index?.find((m) => m.id === id);
    if (entry) {
      entry.messageCount = kept.length;
      entry.updatedAt = Date.now();
      this.scheduleIndexWrite();
    }
    this.logger.info(`Session truncated to ${kept.length} messages (${id})`);
    return kept;
  }

  /** Record "where the previous turn stopped" so a reload can tell whether it may continue */
  async updateStatus(id: string, status: SessionMeta["status"], detail?: string): Promise<void> {
    const entry = this.meta(id);
    if (!entry) return;
    entry.status = status;
    entry.statusDetail = detail;
    entry.updatedAt = Date.now();
    this.scheduleIndexWrite();
  }

  rename(id: string, title: string): void {
    const entry = this.meta(id);
    if (!entry) return;
    entry.title = title.slice(0, 80);
    this.scheduleIndexWrite();
  }

  /** Record the previous turn's intent (carried back by send after a kernel restart) */
  updateLastIntent(id: string, lastIntent: LastIntentDto | undefined): void {
    const entry = this.meta(id);
    if (!entry) return;
    entry.lastIntent = lastIntent;
    entry.updatedAt = Date.now();
    this.scheduleIndexWrite();
  }

  /** Record/update this session's plan (for carrying across turns and restoring after a reload) */
  updatePlan(id: string, plan: PlanStep[] | undefined): void {
    const entry = this.meta(id);
    if (!entry) return;
    entry.plan = plan;
    entry.updatedAt = Date.now();
    this.scheduleIndexWrite();
  }

  async remove(id: string): Promise<void> {
    this.ensureIndex();
    this.index = (this.index ?? []).filter((m) => m.id !== id);
    this.scheduleIndexWrite();
    await fs.promises.rm(this.fileOf(id), { force: true }).catch(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = undefined;
    }
    await this.writeIndex();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = undefined;
    void this.writeIndex();
  }

  // ───────────────────────── internals ─────────────────────────

  private fileOf(id: string): string {
    return path.join(this.dir, `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`);
  }

  private ensureIndex(): void {
    if (this.index) return;
    try {
      const raw = fs.readFileSync(path.join(this.dir, INDEX_FILE), "utf8");
      const parsed = JSON.parse(raw) as { version: number; sessions: SessionMeta[] };
      this.index = parsed.version === INDEX_VERSION && Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch {
      this.index = [];
    }
  }

  private scheduleIndexWrite(): void {
    if (this.indexTimer || this.disposed) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      void this.writeIndex();
    }, 400);
    this.indexTimer.unref?.();
  }

  private async writeIndex(): Promise<void> {
    if (!this.index) return;
    const target = path.join(this.dir, INDEX_FILE);
    const temp = `${target}.tmp`;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(temp, JSON.stringify({ version: INDEX_VERSION, sessions: this.index }), "utf8");
      await fs.promises.rename(temp, target);
    } catch (err) {
      this.logger.warn(`Failed to write session index: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
