import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";

/**
 * The "chat history snapshot" that accompanies a checkpoint -- **stores only a line number**, no message copies.
 *
 * The session itself is append-only JSONL (one message per line, see `sessionStore.ts`), so "what the
 * chat history looked like at a given moment" is equivalent to "how many lines the file has". Storing the
 * line number has advantages:
 *   - the snapshot file is a few dozen bytes, so 100 checkpoints do not bloat anything
 *   - the message text exists only once (the session JSONL), so a "snapshot disagrees with reality" state cannot occur
 *   - rolling back the chat = truncating the JSONL to that line
 *
 * Directory layout: `<globalStorage>/checkpoints/<checkpointId>.json`
 *   { id, sessionId, line, createdAt }
 */
export interface ChatSnapshotMeta {
  id: string;
  sessionId: string;
  /** Number of messages at snapshot time (= number of JSONL lines) */
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
      this.logger.warn(`Failed to create chat snapshot directory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fileOf(id: string): string {
    const safe = /^[0-9a-f]{4,64}$/i.test(id) ? id : "";
    if (!safe) throw new Error(`Invalid checkpoint id: ${id}`);
    return path.join(this.dir, `${safe}.json`);
  }

  /** Record "which line of the chat history this checkpoint corresponds to" */
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
      this.logger.warn(`Failed to save chat snapshot (${id.slice(0, 8)}): ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async load(id: string): Promise<ChatSnapshotMeta | undefined> {
    try {
      const raw = await fs.promises.readFile(this.fileOf(id), "utf8");
      const parsed = JSON.parse(raw) as Partial<ChatSnapshotMeta> & { messageCount?: number; messages?: unknown[] };
      if (typeof parsed.id !== "string" || typeof parsed.sessionId !== "string") return undefined;
      // Backwards compatible with the old format (which stored the full text + messageCount): use the count as the line number
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

  /** Delete a batch of snapshots (called when code checkpoints are invalidated) */
  async remove(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await fs.promises.rm(this.fileOf(id), { force: true });
        } catch (err) {
          this.logger.warn(`Failed to delete chat snapshot (${id.slice(0, 8)}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  }

  /** Enumerate metadata (annotated in the QuickPick as "includes chat snapshot · line N") */
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
