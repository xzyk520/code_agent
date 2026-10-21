import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";
import type { Mode, PlanStep } from "./protocol";

/**
 * 轮次记录：一轮 = 意图分析结果 + 用户输入 + AI 回答 + 用过的工具 + 改动的文件。
 *
 * 为什么要单独存：上下文压缩要"按意图总结"，需要知道每轮**用户想干什么**，
 * 而会话 JSONL 只有消息文本。行号与 JSONL 对齐（messageIndex），
 * 聊天回滚时按行号截断即可。
 *
 * 存储：`<sessions>/<sessionId>.turns.jsonl`，一行一轮，只追加。
 */
export interface TurnRecord {
  /** 意图分析给出的一句话用户意图 */
  intent: string;
  mode: Mode;
  /** 意图判定的任务规模（回滚后恢复 lastIntent 用） */
  scale?: "small" | "large";
  /** 意图判定的"是否需要产出提案" */
  needsProposal?: boolean;
  /** 意图判定的理由 */
  reason?: string;
  /** 用户原话（截断） */
  userText: string;
  /** AI 这一轮的回答（截断） */
  assistant: string;
  /** 本轮调用过的工具名（去重，不含 model/guard） */
  tools: string[];
  /** 本轮产生提案涉及的文件（去重） */
  files: string[];
  /** 工具观察摘要（name: summary），供模型总结时参考 */
  observations: string[];
  /** 本轮最后的计划（跨轮延续用） */
  plan?: PlanStep[];
  /** 本轮用户消息的 id（轨迹跳转用） */
  userMessageId?: string;
  ts: number;
  /** 写完这一轮时，会话 JSONL 的条数（回滚截断用） */
  messageIndex: number;
}

export class TurnStore {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.logger.warn(`轮次目录创建失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fileOf(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
    return path.join(this.dir, `${safe}.turns.jsonl`);
  }

  async append(sessionId: string, record: TurnRecord): Promise<void> {
    try {
      await fs.promises.appendFile(this.fileOf(sessionId), `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      this.logger.warn(`轮次记录写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async list(sessionId: string): Promise<TurnRecord[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.fileOf(sessionId), "utf8");
    } catch {
      return [];
    }
    const out: TurnRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as TurnRecord;
        if (typeof parsed.intent === "string" && typeof parsed.messageIndex === "number") out.push(parsed);
      } catch {
        // 半行损坏：忽略
      }
    }
    return out;
  }

  /** 聊天回滚：保留 messageIndex <= 上限的轮次 */
  async truncate(sessionId: string, maxMessageIndex: number): Promise<void> {
    const turns = await this.list(sessionId);
    const kept = turns.filter((turn) => turn.messageIndex <= maxMessageIndex);
    if (kept.length === turns.length) return;
    const body = kept.map((turn) => JSON.stringify(turn)).join("\n") + (kept.length > 0 ? "\n" : "");
    const file = this.fileOf(sessionId);
    const tmp = `${file}.tmp`;
    try {
      await fs.promises.writeFile(tmp, body, "utf8");
      await fs.promises.rename(tmp, file);
      this.logger.info(`轮次记录截断：${turns.length} → ${kept.length}`);
    } catch (err) {
      this.logger.warn(`轮次记录截断失败: ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async clear(sessionId: string): Promise<void> {
    try {
      await fs.promises.rm(this.fileOf(sessionId), { force: true });
    } catch {
      // 文件不存在就算了
    }
  }
}
