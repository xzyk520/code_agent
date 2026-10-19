import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Logger } from "../log";
import { resolveTarget } from "../paths";
import type { DiffOpenParams, DiffOpenResult } from "../protocol";

/**
 * 虚拟文档 scheme —— 带 publisher 前缀，避免与其他扩展撞名（scheme 是全局命名空间）。
 *
 * VS Code 的 diff 编辑器原生就是「左红右绿」，我们只负责**喂两份内容**：
 *   左侧 = 虚拟文档（写入前的 baseText）
 *   右侧 = 真实文件（写入后的内容）
 *
 * 所以这里只做三件事：注册一个只读虚拟文档 scheme、把内容放进有上限的内存表、调 `vscode.diff`。
 */
const SCHEME = "beecode-xzyk520-base";

/** 内存表上限：条数与总字节都限制，防止一次会话里审阅几十个大文件把内存吃光 */
const MAX_ENTRIES = 50;
const MAX_BYTES = 20 * 1024 * 1024;

interface StoredContent {
  text: string;
  bytes: number;
  /** 对应的真实文件绝对路径（用于「同一文件重新提案时原地刷新」） */
  realPath: string;
}

export class DiffAdapter implements vscode.Disposable {
  private readonly store = new Map<string, StoredContent>();
  /** 每个真实文件最近一次使用的 id —— 重新提案且预览仍打开时可原地刷新 */
  private readonly latestIdByPath = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;
  private totalBytes = 0;
  private disposed = false;

  constructor(private readonly logger: Logger) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => this.store.get(uri.query)?.text ?? "",
      onDidChange: this.onDidChangeEmitter.event,
    });
  }

  async open(params: DiffOpenParams): Promise<DiffOpenResult> {
    let target: vscode.Uri;
    try {
      // 和其他适配器一致：越界/敏感文件在这里就被拒绝（不能借 diff 预览读工作区外的东西）
      target = resolveTarget(params.path);
    } catch (err) {
      this.logger.warn(`diff.open 拒绝 ${params.path}: ${err instanceof Error ? err.message : String(err)}`);
      return { opened: false };
    }

    const key = target.fsPath;
    let id = this.latestIdByPath.get(key);
    const reusing = id !== undefined && this.isDocumentOpen(id);
    if (id === undefined || !reusing) {
      id = randomUUID();
      this.latestIdByPath.set(key, id);
    }

    this.remember(id, params.baseText, key);
    const base = this.virtualUri(target, id);

    if (reusing) {
      // 预览还开着：原地刷新，而不是再堆一个同名标签
      this.onDidChangeEmitter.fire(base);
    }

    const title = params.title ?? `${path.basename(target.fsPath)} — 改动预览`;
    try {
      await vscode.commands.executeCommand("vscode.diff", base, target, title, {
        preview: true,
        preserveFocus: true,
      } as vscode.TextDocumentShowOptions);
      return { opened: true };
    } catch (err) {
      this.logger.warn(`打开 diff 失败: ${err instanceof Error ? err.message : String(err)}`);
      return { opened: false };
    }
  }

  /**
   * 多文件总览：用公开的 `vscode.changes`（内部命令 `_workbench.openMultiDiffEditor` 不稳定）。
   *
   * 右侧一律用**真实文件**，所以不需要 `newText` 参数 —— 传了也不会用。
   */
  async openChanges(entries: Array<{ path: string; baseText: string }>): Promise<DiffOpenResult> {
    if (entries.length === 0) return { opened: false };

    const resources: Array<[vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined]> = [];
    for (const entry of entries) {
      let modified: vscode.Uri;
      try {
        modified = resolveTarget(entry.path);
      } catch (err) {
        this.logger.warn(`openChanges 跳过 ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const id = randomUUID();
      this.latestIdByPath.set(modified.fsPath, id);
      this.remember(id, entry.baseText, modified.fsPath);
      const base = this.virtualUri(modified, id);
      resources.push([modified, base, base]);
    }
    if (resources.length === 0) return { opened: false };

    try {
      await vscode.commands.executeCommand("vscode.changes", "Bee Code 改动", resources);
      return { opened: true };
    } catch (err) {
      this.logger.warn(`打开多文件 diff 失败: ${err instanceof Error ? err.message : String(err)}`);
      return { opened: false };
    }
  }

  /** 幂等：重复调用不会二次注销 provider */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registration.dispose();
    this.onDidChangeEmitter.dispose();
    this.store.clear();
    this.latestIdByPath.clear();
    this.totalBytes = 0;
  }

  // ───────────────────────── 内部 ─────────────────────────

  private virtualUri(target: vscode.Uri, id: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/${path.basename(target.fsPath)}`, // path 必须以 / 开头
      query: id,
    });
  }

  /** 预览文档是否还开着（决定「原地刷新」还是「新开标签」） */
  private isDocumentOpen(id: string): boolean {
    return (vscode.workspace.textDocuments ?? []).some(
      (doc) => doc.uri.scheme === SCHEME && doc.uri.query === id,
    );
  }

  private remember(id: string, text: string, realPath: string): void {
    this.forget(id); // 覆盖同一 id 时先把旧的字节数减掉
    const bytes = Buffer.byteLength(text, "utf8");
    this.store.set(id, { text, bytes, realPath });
    this.totalBytes += bytes;
    this.evictIfNeeded();
  }

  private forget(id: string): void {
    const existing = this.store.get(id);
    if (!existing) return;
    this.totalBytes -= existing.bytes;
    this.store.delete(id);
    if (this.latestIdByPath.get(existing.realPath) === id) {
      this.latestIdByPath.delete(existing.realPath);
    }
  }

  /**
   * 超限时淘汰「最旧且当前没被打开」的条目。
   *
   * 为什么不直接淘汰最旧：如果那个 diff 正开着，内容被清掉后左侧会变成空文件，
   * 用户看到的是「整个文件都被删了」——宁可暂时超一点额度。
   */
  private evictIfNeeded(): void {
    if (this.store.size <= MAX_ENTRIES && this.totalBytes <= MAX_BYTES) return;

    for (const id of [...this.store.keys()]) {
      if (this.store.size <= MAX_ENTRIES && this.totalBytes <= MAX_BYTES) return;
      if (this.isDocumentOpen(id)) continue;
      this.forget(id);
    }

    if (this.store.size > MAX_ENTRIES || this.totalBytes > MAX_BYTES) {
      this.logger.debug(`diff 预览缓存超出上限（${this.store.size} 条）且都还开着，暂时保留`);
    }
  }
}
