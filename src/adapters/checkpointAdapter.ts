import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { Logger } from "../log";
import type { CheckpointCreateParams, CheckpointCreateResult, CheckpointRestoreParams, CheckpointRestoreResult } from "../protocol";

const exec = promisify(execFile);

interface CheckpointRecord {
  id: string;
  label: string;
  createdAt: number;
}

/**
 * 检查点：影子 git 仓库（README §10.5）。
 *
 *   GIT_DIR   = <globalStorage>/shadow.git   ← 与项目 .git 完全隔离
 *   GIT_WORK_TREE = 工作区根
 *
 * 关键：**写入之前**必须有一次快照，否则「写到一半崩了」就无解。
 * 大仓库优化（只快照本次涉及的文件）留作 TODO，见 README §10.5。
 */
export class CheckpointAdapter implements vscode.Disposable {
  private readonly gitDir: string;
  private readonly workTree: string;
  private readonly history: CheckpointRecord[] = [];
  private initialized = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly enabled: boolean,
    private readonly retention: number,
  ) {
    this.gitDir = path.join(context.globalStorageUri.fsPath, "shadow.git");
    this.workTree = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  get available(): boolean {
    return this.enabled && this.workTree.length > 0;
  }

  async create(params: CheckpointCreateParams): Promise<CheckpointCreateResult> {
    if (!this.available) return { id: "", files: 0 };
    await this.ensureRepo();

    const label = params.label ?? new Date().toISOString();
    await this.git(["add", "-A", "--", "."]);
    await this.git(["commit", "-q", "-m", label, "--allow-empty"]);
    const id = (await this.git(["rev-parse", "HEAD"])).trim();

    const files = await this.countTracked();
    this.history.unshift({ id, label, createdAt: Date.now() });
    this.history.splice(this.retention);
    this.logger.debug(`checkpoint ${id.slice(0, 8)} (${files} 个文件)`);
    return { id, files };
  }

  async restore(params: CheckpointRestoreParams): Promise<CheckpointRestoreResult> {
    if (!this.available) throw new Error("检查点未启用（beeCode.checkpoint.enabled=false 或没有工作区）");
    await this.ensureRepo();
    if (!params.id) throw new Error("缺少检查点 id");

    // 先算出「将要被覆盖」的文件（= 当前工作区与目标快照的差异）
    const dirty = await this.git(["diff", "--name-only", params.id]);
    const restored = dirty.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

    await this.git(["checkout", params.id, "--", "."]);
    this.logger.info(`checkpoint 恢复 ${params.id.slice(0, 8)}：${restored.length} 个文件`);
    return { restored };
  }

  list(): CheckpointRecord[] {
    return [...this.history];
  }

  dispose(): void {
    /* git 是短命子进程，无需清理 */
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async ensureRepo(): Promise<void> {
    if (this.initialized) return;
    fs.mkdirSync(this.gitDir, { recursive: true });
    if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
      await this.git(["init", "-q", "--bare"]);
      // 别把影子仓库当成项目仓库的 submodule 或影响 hooks
    }
    this.initialized = true;
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await exec("git", [`--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`, ...args], {
      cwd: this.workTree,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
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
}
