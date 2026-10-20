import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";

/**
 * 会话摘要的持久化（自动保存，无手动入口）。
 *
 * 目的：同一会话重载窗口后，不必重新调用模型做摘要——直接读回上次的结果。
 *
 * 存储：`<sessions>/<sessionId>.summary.json`
 *   { covered, coveredMessageIndex, lines, updatedAt }
 *
 *   covered             已覆盖的轮次数（与 lines 一一对应）
 *   coveredMessageIndex 最后一轮覆盖到的会话消息条数（用于校验会话是否被外部截断）
 *   lines               每条形如 "- 意图：调用了…改动了…实现了…"
 */
export interface StoredSummary {
  covered: number;
  coveredMessageIndex: number;
  lines: string[];
  updatedAt: number;
}

export class SummaryStore {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.logger.warn(`摘要目录创建失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fileOf(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
    return path.join(this.dir, `${safe}.summary.json`);
  }

  async load(sessionId: string): Promise<StoredSummary | undefined> {
    try {
      const raw = await fs.promises.readFile(this.fileOf(sessionId), "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredSummary>;
      if (!Array.isArray(parsed.lines) || typeof parsed.covered !== "number") return undefined;
      return {
        covered: Math.max(0, Math.floor(parsed.covered)),
        coveredMessageIndex: Math.max(0, Math.floor(Number(parsed.coveredMessageIndex) || 0)),
        lines: parsed.lines.filter((line): line is string => typeof line === "string"),
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch {
      return undefined;
    }
  }

  async save(sessionId: string, summary: Omit<StoredSummary, "updatedAt">): Promise<void> {
    const payload: StoredSummary = { ...summary, updatedAt: Date.now() };
    const target = this.fileOf(sessionId);
    const tmp = `${target}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.promises.rename(tmp, target);
    } catch (err) {
      this.logger.warn(`摘要保存失败: ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async remove(sessionId: string): Promise<void> {
    try {
      await fs.promises.rm(this.fileOf(sessionId), { force: true });
    } catch {
      // 不存在就算了
    }
  }
}
