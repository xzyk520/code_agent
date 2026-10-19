import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { Logger } from "./log";
import type { Mode } from "./protocol";

/** 面板消息（与 `ChatMessageView` 同构，单独定义避免和 vscode 依赖纠缠） */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

/** 上一轮停在哪里 —— 重载后据此决定"能不能继续" */
export type TurnStatus = "idle" | "thinking" | "tool" | "awaiting-decision";

export interface SessionSnapshot {
  version: 1;
  sessionId: string;
  mode: Mode;
  messages: StoredMessage[];
  status: TurnStatus;
  /** 停在工具调用时记下工具名，重载提示更具体 */
  statusDetail?: string;
  updatedAt: number;
}

const FILE_VERSION = 1;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SAVE_DEBOUNCE_MS = 400;

/**
 * 会话持久化：把聊天记录与"上一轮停在哪"落到 `<globalStorage>/sessions/<sessionId>.json`。
 *
 * 为什么要它：扩展重载（Reload Window / 更新扩展 / 宿主崩溃）会清空内存，
 * 用户不能接受"聊到一半的记录全没了"。磁盘上的这份快照是唯一的重建依据。
 *
 * 三个刻意的约束：
 *   1. **原子写**：先写 `.tmp` 再 `rename`，避免断电留下半个 JSON
 *   2. **裁剪**：最多 200 条 / 单条 20k 字符 / 整个文件 2MB，防止长期使用把磁盘写满
 *   3. **不存密钥**：快照里只有消息文本与状态，密钥始终只在 SecretStorage
 */
export class SessionStore {
  private timer: NodeJS.Timeout | undefined;
  private pending: SessionSnapshot | undefined;
  private disposed = false;

  constructor(
    private readonly storageDir: string,
    private readonly logger: Logger,
  ) {}

  private get dir(): string {
    return path.join(this.storageDir, "sessions");
  }

  private fileOf(sessionId: string): string {
    // sessionId 由壳生成（`s_<ts>_<rand>`），这里再兜一层，防止出现路径分隔符
    return path.join(this.dir, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    try {
      const raw = await fs.promises.readFile(this.fileOf(sessionId), "utf8");
      const parsed = JSON.parse(raw) as SessionSnapshot;
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.messages)) return undefined;
      return parsed;
    } catch {
      return undefined;   // 没有历史 / 文件损坏：都当成"第一次"
    }
  }

  /** 防抖保存：面板每来一条消息都会调，但只在停止变化 400ms 后写一次盘 */
  save(snapshot: SessionSnapshot): void {
    if (this.disposed) return;
    this.pending = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (next) void this.flush(next);
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** 立即写盘（停用前调用，确保最后几条消息不丢） */
  async flushNow(snapshot: SessionSnapshot): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
    await this.flush(snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const last = this.pending;
    this.pending = undefined;
    if (last) void this.flush(last);
  }

  private async flush(snapshot: SessionSnapshot): Promise<void> {
    const trimmed = prune(snapshot);
    const target = this.fileOf(snapshot.sessionId);
    const temp = `${target}.tmp`;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(temp, JSON.stringify(trimmed), "utf8");
      await fs.promises.rename(temp, target);   // 原子替换
    } catch (err) {
      this.logger.warn(`会话保存失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 裁剪到上限内（保留最新的） */
export function prune(snapshot: SessionSnapshot): SessionSnapshot {
  const messages = snapshot.messages
    .slice(-MAX_MESSAGES)
    .map((m) => (m.text.length > MAX_MESSAGE_CHARS ? { ...m, text: `${m.text.slice(0, MAX_MESSAGE_CHARS)}…` } : m));

  let result: SessionSnapshot = { ...snapshot, messages, updatedAt: Date.now() };

  // 整体仍然超限（极端情况）：从最旧的开始丢
  let size = Buffer.byteLength(JSON.stringify(result), "utf8");
  while (size > MAX_FILE_BYTES && result.messages.length > 1) {
    result = { ...result, messages: result.messages.slice(1) };
    size = Buffer.byteLength(JSON.stringify(result), "utf8");
  }
  return result;
}

/** 给 `vscode.ExtensionContext` 用的便捷入口 */
export function storageDirOf(context: vscode.ExtensionContext): string {
  return context.globalStorageUri.fsPath;
}
