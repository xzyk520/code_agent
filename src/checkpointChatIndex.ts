import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";

/**
 * 检查点配套的「聊天记录快照」——**只存行号**，不复制消息。
 *
 * 会话本身就是 append-only JSONL（一行一条消息，见 `sessionStore.ts`），
 * 所以"聊天记录在某一刻的样子"等价于"文件里有多少行"。存行号的好处：
 *   - 快照文件只有几十字节，100 个检查点也不会膨胀
 *   - 消息全文只有一份（会话 JSONL），不会出现"快照与现状不一致"
 *   - 回滚聊天 = 把 JSONL 截断到那一行
 *
 * 目录布局：`<globalStorage>/checkpoints/<checkpointId>.json`
 *   { id, sessionId, line, createdAt }
 */
export interface ChatSnapshotMeta {
  id: string;
  sessionId: string;
  /** 快照时刻的消息条数（= JSONL 行数） */
  line: number;
  createdAt: number;
}

export class CheckpointChatIndex {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.logger.warn(`聊天快照目录创建失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fileOf(id: string): string {
    const safe = /^[0-9a-f]{4,64}$/i.test(id) ? id : "";
    if (!safe) throw new Error(`非法的检查点 id：${id}`);
    return path.join(this.dir, `${safe}.json`);
  }

  /** 记录"这个检查点对应聊天记录的第几行" */
  async save(id: string, sessionId: string, line: number): Promise<void> {
    const meta: ChatSnapshotMeta = {
      id,
      sessionId,
      line: Math.max(0, Math.floor(line)),
      createdAt: Date.now(),
    };
    const target = this.fileOf(id);
    const tmp = `${target}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(meta), "utf8");
      await fs.promises.rename(tmp, target);
    } catch (err) {
      this.logger.warn(`聊天快照保存失败（${id.slice(0, 8)}）: ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async load(id: string): Promise<ChatSnapshotMeta | undefined> {
    try {
      const raw = await fs.promises.readFile(this.fileOf(id), "utf8");
      const parsed = JSON.parse(raw) as Partial<ChatSnapshotMeta> & { messageCount?: number; messages?: unknown[] };
      if (typeof parsed.id !== "string" || typeof parsed.sessionId !== "string") return undefined;
      // 兼容旧格式（曾存过全文 + messageCount）：取条数当行号
      const line =
        typeof parsed.line === "number"
          ? parsed.line
          : typeof parsed.messageCount === "number"
            ? parsed.messageCount
            : Array.isArray(parsed.messages)
              ? parsed.messages.length
              : 0;
      return {
        id: parsed.id,
        sessionId: parsed.sessionId,
        line,
        createdAt: Number(parsed.createdAt) || 0,
      };
    } catch {
      return undefined;
    }
  }

  /** 删除一批快照（代码检查点被作废时调用） */
  async remove(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await fs.promises.rm(this.fileOf(id), { force: true });
        } catch (err) {
          this.logger.warn(`聊天快照删除失败（${id.slice(0, 8)}）: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  }

  /** 枚举元信息（QuickPick 里标注"含聊天快照 · 第 N 行"） */
  async list(): Promise<ChatSnapshotMeta[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const out: ChatSnapshotMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const meta = await this.load(name.slice(0, -5));
      if (meta) out.push(meta);
    }
    return out;
  }
}
