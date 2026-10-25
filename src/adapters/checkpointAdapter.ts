import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { Logger } from "../log";
import type { CheckpointCreateParams, CheckpointCreateResult, CheckpointRestoreParams, CheckpointRestoreResult } from "../protocol";

const exec = promisify(execFile);

/** Compaction slack: compact only once history reaches retention + this many commits, so every create doesn't rewrite history */
const COMPACT_SLACK = 10;

/** With retention=0 (no compaction), list() shows at most this many entries, so the QuickPick isn't stuffed with thousands of items */
const LIST_LIMIT_WHEN_UNBOUNDED = 500;

export interface CheckpointRecord {
  id: string;
  label: string;
  createdAt: number;
}

/**
 * Checkpoints: a shadow git repository (README §10.5).
 *
 *   GIT_DIR       = <globalStorage>/shadow.git   ← completely isolated from the project's .git
 *   GIT_WORK_TREE = the workspace root (taken fresh on every operation, supports switching/adding folders)
 *
 * Key point: a snapshot must exist **before writing**, otherwise "crashed halfway through a write" is unrecoverable.
 *
 * Seven pitfalls hit in the past (all handled):
 *   1. Commit identity: do not rely on the user's git config; override with `-c user.name/email` in the command
 *   2. History lived only in memory → `list()` now reads from `git log`, so rollback still works after a window reload
 *   3. The shadow repo only ever grew → past retention, rebuild the parent chain with `commit-tree` + `gc --prune=now`
 *   4. Adding the whole tree is slow on big repos → `paths` snapshots only the specified files
 *   5. Concurrent creates colliding on `index.lock` → an internal promise queue serializes them
 *   6. Silently returning an empty id when unavailable → return `skipped + reason`, so callers can tell "didn't do it" from "did it"
 *   7. Task-level rollback: the shell can only restore **files**; session/task state is synthesized by the core itself (the protocol dropped scope)
 */
export class CheckpointAdapter implements vscode.Disposable {
  private readonly gitDir: string;
  private initialized = false;
  /** Serial queue: git's index.lock does not support concurrent writes */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly enabled: boolean,
    private readonly retention: number,
  ) {
    this.gitDir = path.join(context.globalStorageUri.fsPath, "shadow.git");
  }

  /** Workspace root: taken fresh every time, so it isn't frozen at construction (the user may switch or add folders) */
  private get workTree(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  get available(): boolean {
    return this.enabled && this.workTree.length > 0;
  }

  async create(params: CheckpointCreateParams): Promise<CheckpointCreateResult> {
    return this.serialize(() => this.createInner(params));
  }

  async restore(params: CheckpointRestoreParams): Promise<CheckpointRestoreResult> {
    return this.serialize(async () => {
      if (!this.available) {
        throw new Error("检查点未启用（beeCode.checkpoint.enabled=false 或没有工作区）");
      }
      if (!params.id) throw new Error("缺少检查点 id");
      await this.ensureRepo();

      // First work out which files "are about to be overwritten" (= the diff between the current workspace and the target snapshot), then overwrite
      const dirty = await this.git(["diff", "--name-only", params.id, "--", "."]);
      const restored = dirty.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

      await this.git(["checkout", params.id, "--", "."]);
      this.logger.info(`checkpoint 恢复 ${params.id.slice(0, 8)}：${restored.length} 个文件`);
      return { restored };
    });
  }

  /**
   * Command-level checkpoint: returns the files changed relative to the given snapshot.
   *
   * Stage the workspace into the shadow index first (never touching the project's .git), so newly added files get diffed too;
   * the returned paths are workspace-relative.
   */
  async diff(id: string): Promise<string[]> {
    return this.serialize(async () => {
      if (!this.available) return [];
      if (!id) return [];
      await this.ensureRepo();
      await this.git(["add", "-A", "--", "."]);
      const out = await this.git(["diff", "--cached", "--name-status", id, "--", "."]);
      const files: string[] = [];
      for (const line of out.split("\n")) {
        const parts = line.trim().split("\t");
        if (parts.length === 0 || !parts[0]) continue;
        const status = parts[0][0];
        const target = status === "R" || status === "C" ? parts[2] : parts[1];
        if (target) files.push(target);
      }
      return [...new Set(files)];
    });
  }

  /**
   * Restore only the specified files to their snapshot state:
   *   - added by the command but absent from the snapshot → delete
   *   - present in the snapshot but modified/deleted by the command → checkout them back
   * Other files in the workspace are untouched.
   */
  async restorePaths(id: string, paths: string[]): Promise<string[]> {
    return this.serialize(async () => {
      if (!this.available) throw new Error("检查点未启用（beeCode.checkpoint.enabled=false 或没有工作区）");
      if (!id) throw new Error("缺少检查点 id");
      const wanted = paths
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .filter((p) => !path.isAbsolute(p) && !p.startsWith(".."));
      if (wanted.length === 0) return [];
      await this.ensureRepo();
      await this.git(["add", "-A", "--", "."]);
      const out = await this.git(["diff", "--cached", "--name-status", id, "--", ...wanted]);
      const restored: string[] = [];
      const checkout: string[] = [];
      for (const line of out.split("\n")) {
        const parts = line.trim().split("\t");
        if (parts.length === 0 || !parts[0]) continue;
        const status = parts[0][0];
        if (status === "A") {
          const rel = parts[1] ?? "";
          const file = path.resolve(this.workTree, rel);
          const inside = path.relative(path.resolve(this.workTree), file);
          if (rel && inside && !inside.startsWith("..") && !path.isAbsolute(inside)) {
            await fs.promises.rm(file, { force: true });
            restored.push(rel);
          }
        } else if (status === "R" || status === "C") {
          const target = parts[2] ?? "";
          const file = path.resolve(this.workTree, target);
          const inside = path.relative(path.resolve(this.workTree), file);
          if (target && inside && !inside.startsWith("..") && !path.isAbsolute(inside)) {
            await fs.promises.rm(file, { force: true });
            restored.push(target);
          }
          if (parts[1]) checkout.push(parts[1]);
        } else if (parts[1]) {
          checkout.push(parts[1]);
        }
      }
      if (checkout.length > 0) {
        await this.git(["checkout", id, "--", ...checkout]);
        restored.push(...checkout);
      }
      this.logger.info(`命令级恢复 ${id.slice(0, 8)}：${restored.length} 个文件`);
      return [...new Set(restored)];
    });
  }

  /** Read from git history (not from memory), so old checkpoints still list after a window reload */
  async list(): Promise<CheckpointRecord[]> {
    return this.serialize(() => this.listInner());
  }

  private async listInner(): Promise<CheckpointRecord[]> {
    if (!this.available) return [];
    try {
      await this.ensureRepo();
      // retention=0 means "no compaction", and `-n 0` cannot be used then (it returns an empty list), so use a display cap instead
      const limit = this.retention > 0 ? this.retention : LIST_LIMIT_WHEN_UNBOUNDED;
      const out = await this.git(["log", `--format=%H%x09%ct%x09%s`, "-n", String(limit)]);
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [id = "", ts = "0", ...rest] = line.split("\t");
          return { id, label: rest.join("\t"), createdAt: Number(ts) * 1000 };
        })
        .filter((record) => record.id.length > 0);
    } catch {
      // Repository not created yet / no commits at all yet: no checkpoints
      return [];
    }
  }

  /**
   * Move the shadow repo's HEAD back to the given checkpoint, voiding "newer snapshots".
   *
   * Semantics (matching the rollback in README §10.5):
   *   - the target checkpoint itself stays unchanged
   *   - checkpoints newer than it "disappear" from history (the branch pointer moves back, later commits continue from the target)
   *   - returns the voided ids so the caller can delete the matching chat snapshots
   */
  async rewind(id: string): Promise<{ voided: string[] }> {
    return this.serialize(async () => {
      if (!this.available) throw new Error("检查点未启用");
      const records = await this.listInner();
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error("检查点不存在（可能已被历史压缩）");
      const voided = records.slice(0, index).map((record) => record.id);
      if (voided.length > 0) {
        await this.git(["update-ref", "HEAD", id]);
        this.logger.info(`检查点回退：作废 ${voided.length} 个后续快照（目标 ${id.slice(0, 8)}）`);
      }
      return { voided };
    });
  }

  dispose(): void {
    /* git is a short-lived child process, so there is nothing to clean up */
  }

  // ───────────────────────── Internals ─────────────────────────

  private async createInner(params: CheckpointCreateParams): Promise<CheckpointCreateResult> {
    if (!this.enabled) {
      this.logger.debug("checkpoint 跳过：设置里关闭了检查点");
      return { id: "", files: 0, skipped: true, reason: "beeCode.checkpoint.enabled=false" };
    }
    if (!this.workTree) {
      this.logger.warn("checkpoint 跳过：没有打开工作区");
      return { id: "", files: 0, skipped: true, reason: "没有打开工作区" };
    }

    await this.ensureRepo();
    const label = params.label ?? new Date().toISOString();

    // Lightweight mode: snapshot only the given paths (a large repo needn't add the whole tree)
    const paths = (params.paths ?? []).filter((p) => p.trim().length > 0);
    if (paths.length > 0) {
      await this.git(["add", "-A", "--", ...paths]);
    } else {
      await this.git(["add", "-A", "--", "."]);
    }
    await this.git(["commit", "-q", "-m", label, "--allow-empty"]);
    const id = (await this.git(["rev-parse", "HEAD"])).trim();
    const files = await this.countTracked();

    await this.compactIfNeeded();

    this.logger.debug(`checkpoint ${id.slice(0, 8)} (${files} 个文件${paths.length > 0 ? `，指定 ${paths.length} 个路径` : ""})`);
    return { id, files };
  }

  /**
   * History compaction: keep only the most recent `retention` snapshots.
   *
   * Plain `gc` cannot delete old commits — they sit on HEAD's parent chain and are therefore always reachable.
   * So the parent chain must be **rewritten**: re-chain the most recent N trees with `commit-tree`,
   * making the older ancestors unreachable, and then let `gc --prune=now` actually reclaim the objects.
   *
   * ⚠️ Hysteresis: compacting the moment retention is reached would mean **every subsequent create**
   * rewrites N commits and gc's again — an edit-heavy session would stall for seconds each round. So wait until
   * `retention + COMPACT_SLACK` accumulates, then compact back down to `retention` in one go, cutting the amortized cost to 1/10.
   */
  private async compactIfNeeded(): Promise<void> {
    if (this.retention <= 0) return;
    const threshold = this.retention + COMPACT_SLACK;

    const count = Number((await this.git(["rev-list", "--count", "HEAD"])).trim() || "0");
    if (!Number.isFinite(count) || count <= threshold) return;

    const lines = (await this.git(["log", "--format=%H%x09%s", "-n", String(this.retention)]))
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (lines.length < 2) return;

    // Keep each snapshot's original message, so labels in list() don't turn into "compacted xxxx" after compaction
    const keep = lines.slice(0, this.retention).reverse().map((line) => {
      const [id = "", ...rest] = line.split("\t");
      return { id, subject: rest.join("\t") };
    });

    let parent: string | undefined;
    for (const commit of keep) {
      const tree = (await this.git(["rev-parse", `${commit.id}^{tree}`])).trim();
      const args = ["commit-tree", tree, "-m", commit.subject || `compacted ${commit.id.slice(0, 8)}`];
      if (parent) args.push("-p", parent);
      parent = (await this.git(args)).trim();
    }
    if (!parent) return;

    const headRef = (await this.git(["symbolic-ref", "--short", "HEAD"])).trim() || "master";
    await this.git(["update-ref", `refs/heads/${headRef}`, parent]);
    await this.git(["reflog", "expire", "--expire=now", "--all"]);
    await this.git(["gc", "--prune=now", "--quiet"]);
    this.logger.debug(`checkpoint 历史压缩：${lines.length} → ${keep.length}`);
  }

  private async ensureRepo(): Promise<void> {
    if (this.initialized) return;
    fs.mkdirSync(this.gitDir, { recursive: true });
    if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
      // ⚠️ `init` cannot take `--work-tree` (git reports "GIT_WORK_TREE ... not allowed
      // without specifying GIT_DIR"), so it runs as a separate command, bypassing this.git()
      await exec("git", [`--git-dir=${this.gitDir}`, "init", "-q", "--bare"], {
        windowsHide: true,
        timeout: 30_000,
      });
    }
    this.initialized = true;
  }

  /**
   * Run a single git command.
   *
   * Three points:
   *   - `--git-dir` / `--work-tree` are passed as arguments (not environment variables: explicit and easier to debug)
   *   - `-c user.name/email`: **do not rely on the user's global git config**, otherwise users who never configured an identity
   *     fail outright on `git commit` (the easiest pitfall to miss)
   *   - `timeout`: keeps git from hanging on a large repo and dragging the whole shell down with it
   */
  private async git(args: string[]): Promise<string> {
    const { stdout } = await exec(
      "git",
      [
        `--git-dir=${this.gitDir}`,
        `--work-tree=${this.workTree}`,
        "-c",
        "user.name=Bee Code",
        "-c",
        "user.email=beecode@localhost",
        ...args,
      ],
      { cwd: this.workTree || undefined, maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
    );
    return stdout;
  }

  private async countTracked(): Promise<number> {
    try {
      const out = await this.git(["ls-files"]);
      return out.split("\n").filter((s) => s.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  /** Serialize: keep running the next one even if the previous failed (a single failed snapshot must not block everything after it) */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
