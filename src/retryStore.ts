import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";

export type RetryStatus = "waiting" | "starting" | "done" | "failed" | "cancelled";

/** 一条可持久化的模型重试事件；只追加，不参与聊天消息投影。 */
export interface RetryEvent {
  ts: number;
  sessionId: string;
  status: RetryStatus;
  attempt?: number;
  max?: number;
  delayMs?: number;
  reason?: string;
}

/** 最近一次尚未确认完成的请求；用于重载后恢复“重试本轮”。 */
export interface PendingTurn {
  sessionId: string;
  text: string;
  mode: string;
  attachments: unknown[];
  savedAt: number;
}

/**
 * 模型重试事件 / 待完成请求的持久化。
 *
 * 存储：
 *   <sessions>/<sessionId>.retries.jsonl   一行一个事件，只追加
 *   <sessions>/<sessionId>.pending.json    最近一次未完成请求（原子覆盖）
 *
 * 重试事件在等待退避前写入；如果进程在等待中崩溃，重载后仍能看到
 * 最后状态是 waiting/starting，而不是把“正在重试”误当成从未发生。
 */
export class RetryStore {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  /** 追加一条重试事件；失败只记日志，不影响主流程。 */
  async append(event: RetryEvent): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.appendFile(this.fileOf(event.sessionId), `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      this.logger.warn(`重试事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 同步追加：通知线程里用，保证事件在返回前已经落盘。 */
  appendSync(event: RetryEvent): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.fileOf(event.sessionId), `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      this.logger.warn(`重试事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 读取某会话的全部重试事件（坏行跳过）。 */
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
        // 崩溃留下的半行：忽略
      }
    }
    return out;
  }

  async latest(sessionId: string): Promise<RetryEvent | undefined> {
    const events = await this.load(sessionId);
    return events[events.length - 1];
  }

  /** 保存最近一次请求；在调用模型前落盘。 */
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
