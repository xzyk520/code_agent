import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { Logger } from "../log";
import type { CheckpointCreateParams, CheckpointCreateResult, CheckpointRestoreParams, CheckpointRestoreResult } from "../protocol";

const exec = promisify(execFile);

/** 压缩滞后量：攒到 retention + 这个数才压缩，避免每次 create 都重写历史 */
const COMPACT_SLACK = 10;

/** retention=0（不压缩）时，list() 最多显示这么多条，避免 QuickPick 塞几千项 */
const LIST_LIMIT_WHEN_UNBOUNDED = 500;

export interface CheckpointRecord {
  id: string;
  label: string;
  createdAt: number;
}

/**
 * 检查点：影子 git 仓库（README §10.5）。
 *
 *   GIT_DIR       = <globalStorage>/shadow.git   ← 与项目 .git 完全隔离
 *   GIT_WORK_TREE = 工作区根（每次操作时现取，支持切换/新增文件夹）
 *
 * 关键：**写入之前**必须有一次快照，否则「写到一半崩了」就无解。
 *
 * 七个曾经踩过的坑（都已处理）：
 *   1. 提交身份：不依赖用户 git 配置，命令里用 `-c user.name/email` 覆盖
 *   2. 历史只在内存 → `list()` 改为从 `git log` 读，重载窗口后仍可回滚
 *   3. 影子仓库只增不减 → 超过 retention 时用 `commit-tree` 重建父链 + `gc --prune=now`
 *   4. 大仓库 add 全树慢 → 支持 `paths` 只快照指定文件
 *   5. 并发 create 撞 `index.lock` → 内部 promise 队列串行化
 *   6. 不可用时静默返回空 id → 返回 `skipped + reason`，调用方能区分「没做」和「做了」
 *   7. 任务级回滚：壳只能恢复**文件**，会话/任务状态由内核自己合成（协议已移除 scope）
 */
export class CheckpointAdapter implements vscode.Disposable {
  private readonly gitDir: string;
  private initialized = false;
  /** 串行队列：git 的 index.lock 不支持并发写 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly enabled: boolean,
    private readonly retention: number,
  ) {
    this.gitDir = path.join(context.globalStorageUri.fsPath, "shadow.git");
  }

  /** 工作区根：每次现取，避免构造时冻结（用户可能切换或新增文件夹） */
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

      // 先算出「将要被覆盖」的文件（= 当前工作区与目标快照的差异），再覆盖
      const dirty = await this.git(["diff", "--name-only", params.id, "--", "."]);
      const restored = dirty.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

      await this.git(["checkout", params.id, "--", "."]);
      this.logger.info(`checkpoint 恢复 ${params.id.slice(0, 8)}：${restored.length} 个文件`);
      return { restored };
    });
  }

  /** 从 git 历史读（不依赖内存），重载窗口后仍能列出旧检查点 */
  async list(): Promise<CheckpointRecord[]> {
    return this.serialize(async () => {
      if (!this.available) return [];
      try {
        await this.ensureRepo();
        // retention=0 表示「不压缩」，此时不能用 `-n 0`（会返回空列表），给个显示上限
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
        // 仓库还没建 / 还没有任何 commit：没有检查点
        return [];
      }
    });
  }

  dispose(): void {
    /* git 是短命子进程，无需清理 */
  }

  // ───────────────────────── 内部 ─────────────────────────

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

    // 轻量模式：只快照指定路径（大仓库不必全树 add）
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
   * 历史压缩：只保留最近 `retention` 个快照。
   *
   * 单纯 `gc` 删不掉旧 commit —— 它们在 HEAD 的父链上，永远是 reachable。
   * 所以要**重写父链**：把最近 N 个 tree 用 `commit-tree` 重新串起来，
   * 让更早的祖先变成 unreachable，再 `gc --prune=now` 真正回收对象。
   *
   * ⚠️ 滞后阈值（hysteresis）：如果一到 retention 就压，之后**每次 create 都会**
   * 重写 N 个 commit 再 gc —— 编辑密集的会话每轮卡几秒。所以等攒到
   * `retention + COMPACT_SLACK` 再一次性压回 `retention`，把摊销成本降到 1/10。
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

    // 保留原来每个快照的 message，这样压缩后 list() 里的 label 不会变成 "compacted xxxx"
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
      // ⚠️ `init` 不能带 `--work-tree`（git 会报 "GIT_WORK_TREE ... not allowed
      // without specifying GIT_DIR"），所以这里单独走一条命令，不经过 this.git()
      await exec("git", [`--git-dir=${this.gitDir}`, "init", "-q", "--bare"], {
        windowsHide: true,
        timeout: 30_000,
      });
    }
    this.initialized = true;
  }

  /**
   * 执行一条 git 命令。
   *
   * 三个要点：
   *   - `--git-dir` / `--work-tree` 用参数传（不用环境变量，显式且好调试）
   *   - `-c user.name/email`：**不依赖用户的全局 git 配置**，否则没配过身份的用户
   *     在 `git commit` 时会直接失败（这是最容易漏的坑）
   *   - `timeout`：避免大仓库上 git 卡死拖住整个壳
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

  /** 串行化：前一个失败也要继续跑下一个（不能因为一次快照失败就卡死后续） */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
