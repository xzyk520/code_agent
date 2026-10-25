import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";

/**
 * Persistence for session summaries (saved automatically, no manual entry point).
 *
 * Purpose: after reloading the window for the same session there is no need to call the model again for
 * a summary -- just read back the previous result.
 *
 * Storage: `<sessions>/<sessionId>.summary.json`
 *   { covered, coveredMessageIndex, lines, updatedAt }
 *
 *   covered             number of turns already covered (one-to-one with lines)
 *   coveredMessageIndex number of session messages covered by the last turn (used to verify the session was not truncated externally)
 *   lines               each line looks like "- intent: called ... changed ... implemented ..."
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
      // If it does not exist, never mind
    }
  }
}
