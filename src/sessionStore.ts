import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";
import type { Mode, PlanStep } from "./protocol";

/** 一条已落盘的消息（追加写，永不修改） */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}

export type TurnStatus = "idle" | "thinking" | "tool" | "awaiting-decision";

export interface SessionMeta {
  id: string;
  /** 标题：取第一条用户消息的前 40 字 */
  title: string;
  mode: Mode;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** 上一次崩溃/重载时停在哪个阶段（见 docs §9.3） */
  status?: TurnStatus;
  statusDetail?: string;
  /** 最近一次计划（跨轮延续 + 重载后恢复面板） */
  plan?: PlanStep[];
}

const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;

/**
 * 会话仓库：**完整对话落盘**（append-only JSONL）+ 一份索引。
 *
 * 目录布局（默认 `<globalStorage>/sessions/`，可用 `beeCode.session.dir` 覆盖）：
 *
 *   sessions/
 *     index.json                 ← 会话列表（标题/时间/消息数），供 UI 快速枚举
 *     <sessionId>.jsonl          ← 完整记录，一行一条消息，只追加
 *
 * 为什么是 JSONL 而不是单个 JSON：
 *   - 追加写，崩溃最多丢最后半行；整份重写则会丢掉整个会话
 *   - 完整历史永不被截断（模型上下文是另一回事：只取需要的部分，见 `contextBuilder.ts`）
 *   - 与 Claude Code（`~/.claude/projects/<proj>/<id>.jsonl`）、Codex（`~/.codex/sessions/**`）同构，便于排查与迁移
 */
export class SessionStore {
  private index: SessionMeta[] | undefined;
  private indexTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    /** 根目录（默认 globalStorage 的 sessions 子目录） */
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  /** 列出所有会话（最近更新的在前） */
  list(): SessionMeta[] {
    this.ensureIndex();
    return [...(this.index ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  meta(id: string): SessionMeta | undefined {
    this.ensureIndex();
    return this.index?.find((m) => m.id === id);
  }

  /** 读取某会话的完整消息（坏行跳过，不让一行坏数据拖垮整个会话） */
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
        // 崩溃留下的半行：忽略
      }
    }
    return out;
  }

  /** 创建会话（只登记索引，不建文件；第一条消息时才真正落盘） */
  create(meta: Omit<SessionMeta, "messageCount" | "updatedAt">): void {
    this.ensureIndex();
    this.index = (this.index ?? []).filter((m) => m.id !== meta.id);
    this.index.push({ ...meta, messageCount: 0, updatedAt: Date.now() });
    this.scheduleIndexWrite();
  }

  /** 追加一条消息：立刻写 JSONL，索引防抖更新 */
  append(id: string, message: StoredMessage): void {
    void this.appendAsync(id, message);
  }

  async appendAsync(id: string, message: StoredMessage): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.appendFile(this.fileOf(id), `${JSON.stringify(message)}\n`, "utf8");
    } catch (err) {
      this.logger.warn(`会话写入失败: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.ensureIndex();
    const entry = this.index?.find((m) => m.id === id);
    if (entry) {
      entry.messageCount += 1;
      entry.updatedAt = Date.now();
      if (message.role === "user" && entry.title === "新会话") {
        entry.title = message.text.replace(/\s+/g, " ").trim().slice(0, 40) || "新会话";
      }
      this.scheduleIndexWrite();
    }
  }

  /**
   * 把会话截断到前 `messageCount` 条（回滚聊天记录用）。
   *
   * JSONL 是追加写的；截断时整份重写（先写临时文件再 rename），
   * 避免写到一半崩掉把整个会话弄坏。
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
      this.logger.warn(`会话截断失败: ${err instanceof Error ? err.message : String(err)}`);
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
    this.logger.info(`会话已截断到 ${kept.length} 条（${id}）`);
    return kept;
  }

  /** 记录"上一轮停在哪"，供重载后判断能否继续 */
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

  /** 记录/更新本会话的计划（用于跨轮延续与重载恢复） */
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

  // ───────────────────────── 内部 ─────────────────────────

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
      this.logger.warn(`会话索引写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
