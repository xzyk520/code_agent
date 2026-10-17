import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Logger } from "../log";
import type { DiffOpenParams, DiffOpenResult } from "../protocol";

const SCHEME = "beecode-base";

/**
 * 红绿预览（README §11.1 方案 A）。
 *
 * VS Code 的 diff 编辑器原生就是「左红右绿」，我们只负责**喂两份内容**：
 *   左侧 = 虚拟文档（写入前的 baseText）
 *   右侧 = 真实文件（写入后的内容）
 *
 * 所以这里只做两件事：注册一个只读虚拟文档 scheme + 调 `vscode.diff`。
 */
export class DiffAdapter implements vscode.Disposable {
  private readonly store = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor(private readonly logger: Logger) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => this.store.get(uri.query) ?? "",
    });
  }

  async open(params: DiffOpenParams): Promise<DiffOpenResult> {
    const target = vscode.Uri.file(path.resolve(params.path));
    const id = randomUUID();
    this.store.set(id, params.baseText);

    const base = vscode.Uri.from({
      scheme: SCHEME,
      path: `/${path.basename(target.fsPath)}`,
      query: id,
    });
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

  /** 多文件总览：用公开的 `vscode.changes`（内部命令 _workbench.openMultiDiffEditor 不稳定） */
  async openChanges(entries: Array<{ path: string; baseText: string; newText: string }>): Promise<void> {
    if (entries.length === 0) return;
    const resources: Array<[vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined]> = entries.map((entry) => {
      const id = randomUUID();
      this.store.set(id, entry.baseText);
      const base = vscode.Uri.from({ scheme: SCHEME, path: `/${path.basename(entry.path)}`, query: id });
      const modified = vscode.Uri.file(path.resolve(entry.path));
      return [modified, base, base];
    });
    await vscode.commands.executeCommand("vscode.changes", "Bee Code 改动", resources);
  }

  dispose(): void {
    this.registration.dispose();
    this.store.clear();
  }
}
