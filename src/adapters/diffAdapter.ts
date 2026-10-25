import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Logger } from "../log";
import { resolveTarget } from "../paths";
import type { DiffOpenParams, DiffOpenResult } from "../protocol";

/**
 * Virtual document scheme — prefixed with the publisher to avoid colliding with other extensions (schemes are a global namespace).
 *
 * VS Code's diff editor is natively "red on the left, green on the right"; we only **feed it two pieces of content**:
 *   left  = virtual document (baseText before the write)
 *   right = real file (content after the write)
 *
 * So there are only three things here: register a read-only virtual document scheme, put content into a size-capped in-memory table, and call `vscode.diff`.
 */
const SCHEME = "beecode-xzyk520-base";

/** In-memory table caps: both entry count and total bytes, so reviewing dozens of large files in one session cannot eat all the memory */
const MAX_ENTRIES = 50;
const MAX_BYTES = 20 * 1024 * 1024;

interface StoredContent {
  text: string;
  bytes: number;
  /** Absolute path of the corresponding real file (used to refresh in place when the same file is proposed again) */
  realPath: string;
}

export class DiffAdapter implements vscode.Disposable {
  private readonly store = new Map<string, StoredContent>();
  /** Most recently used id per real file — allows an in-place refresh when it is proposed again and the preview is still open */
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
      // Consistent with the other adapters: out-of-bounds/sensitive files are rejected right here (a diff preview must not read outside the workspace)
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
      // Preview is still open: refresh in place instead of piling up another tab with the same name
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
   * Preview a **proposal**: left = real file (current), right = the virtual "corrected" version.
   *
   * The opposite direction from `open()`: there the left side is "before the change", whereas here the left side is "what is on disk now"
   * and the right side is the candidate content from the core. The green the user sees is "what would be written on accept".
   */
  async openProposal(params: { path: string; text: string; title?: string }): Promise<DiffOpenResult> {
    let target: vscode.Uri;
    try {
      target = resolveTarget(params.path);
    } catch (err) {
      this.logger.warn(`diff.openProposal 拒绝 ${params.path}: ${err instanceof Error ? err.message : String(err)}`);
      return { opened: false };
    }

    const key = `proposed:${target.fsPath}`;
    let id = this.latestIdByPath.get(key);
    const reusing = id !== undefined && this.isDocumentOpen(id);
    if (id === undefined || !reusing) {
      id = randomUUID();
      this.latestIdByPath.set(key, id);
    }

    this.remember(id, params.text, key);
    const proposed = this.virtualUri(target, id);
    if (reusing) this.onDidChangeEmitter.fire(proposed);

    const title = params.title ?? `${path.basename(target.fsPath)} — 提案预览`;
    try {
      await vscode.commands.executeCommand("vscode.diff", target, proposed, title, {
        preview: true,
        preserveFocus: false,
      } as vscode.TextDocumentShowOptions);
      return { opened: true };
    } catch (err) {
      this.logger.warn(`打开提案 diff 失败: ${err instanceof Error ? err.message : String(err)}`);
      return { opened: false };
    }
  }

  /**
   * Multi-file overview: uses the public `vscode.changes` (the internal `_workbench.openMultiDiffEditor` command is unstable).
   *
   * The right side is always the **real file**, so no `newText` parameter is needed — it would be ignored anyway.
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

  /** Idempotent: repeated calls do not unregister the provider a second time */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registration.dispose();
    this.onDidChangeEmitter.dispose();
    this.store.clear();
    this.latestIdByPath.clear();
    this.totalBytes = 0;
  }

  // ───────────────────────── Internals ─────────────────────────

  private virtualUri(target: vscode.Uri, id: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/${path.basename(target.fsPath)}`, // path must start with /
      query: id,
    });
  }

  /** Whether the preview document is still open (decides between "refresh in place" and "new tab") */
  private isDocumentOpen(id: string): boolean {
    return (vscode.workspace.textDocuments ?? []).some(
      (doc) => doc.uri.scheme === SCHEME && doc.uri.query === id,
    );
  }

  private remember(id: string, text: string, realPath: string): void {
    this.forget(id); // when overwriting the same id, subtract the old byte count first
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
   * When over the cap, evict the "oldest entry that is not currently open".
   *
   * Why not just evict the oldest: if that diff is open, wiping its content turns the left side into an empty file,
   * and what the user sees is "the whole file was deleted" — better to exceed the budget for a little while.
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
