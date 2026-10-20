import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";
import type { StoredMessage } from "./sessionStore";

/** 一份聊天记录快照：与某个代码检查点一一对应 */
export interface ChatSnapshot {
  id: string;
  sessionId: string;
  messageCount: number;
  createdAt: number;
  messages: StoredMessage[];
}

export interface ChatSnapshotMeta {
  id: string;
  sessionId: string;
  messageCount: number;
  createdAt: number;
}

/**
 * 检查点配套的「聊天记录快照」。
 *
 * 为什么单独存：影子 git 只管工作区文件；把会话 JSONL 塞进 git 会让历史体积翻倍，
 * 而且回滚聊天需要的是"消息条数 + 内容"，不是文件 diff。所以每份快照一个 JSON：
 *
 *   <globalStorage>/checkpoints/<checkpointId>.json
 *     { id, sessionId, messageCount, createdAt, messages: [...] }
 *
 * 生命周期与代码检查点绑定：代码检查点被"作废"时，对应快照也删除。
 */
export class CheckpointChatStore {
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
    // id 是 git commit sha；仍做一次白名单校验，避免路径穿越
    const safe = /^[0-9a-f]{4,64}$/i.test(id) ? id : "";
    if (!safe) throw new Error(`非法的检查点 id：${id}`);
    return path.join(this.dir, `${safe}.json`);
  }

  async save(id: string, sessionId: string, messages: StoredMessage[]): Promise<void> {
    const payload: ChatSnapshot = {
      id,
      sessionId,
      messageCount: messages.length,
      createdAt: Date.now(),
      messages,
    };
    const target = this.fileOf(id);
    const tmp = `${target}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.promises.rename(tmp, target);
    } catch (err) {
      this.logger.warn(`聊天快照保存失败（${id.slice(0, 8)}）: ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async load(id: string): Promise<ChatSnapshot | undefined> {
    try {
      const raw = await fs.promises.readFile(this.fileOf(id), "utf8");
      const parsed = JSON.parse(raw) as ChatSnapshot;
      if (!Array.isArray(parsed.messages)) return undefined;
      return parsed;
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

  /** 枚举已有快照的元信息（QuickPick 里标注"含聊天快照"） */
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
      try {
        const raw = await fs.promises.readFile(path.join(this.dir, name), "utf8");
        const parsed = JSON.parse(raw) as ChatSnapshot;
        if (typeof parsed.id !== "string" || typeof parsed.sessionId !== "string") continue;
        out.push({
          id: parsed.id,
          sessionId: parsed.sessionId,
          messageCount: Number(parsed.messageCount) || 0,
          createdAt: Number(parsed.createdAt) || 0,
        });
      } catch {
        // 半份损坏的快照忽略
      }
    }
    return out;
  }
}
