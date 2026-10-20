import * as vscode from "vscode";
import type { FocusInfo } from "./focus";
import type { Logger } from "./log";
import { toWorkspaceRelative } from "./paths";

/**
 * 隐式选区高亮：把"agent 实际读了哪一段"画在编辑器里。
 *
 * 为什么需要：自动附加的代码用户在面板里看不到范围（只有一条 hint），
 * 不画出来就没法判断"它是不是看错地方了"。
 *
 * 行为：
 *   - 发送/附加时高亮对应编辑器里的行范围（虚线框 + 概览标尺）
 *   - 5 秒后自动淡出；下一次高亮会先清掉上一处
 *   - 只对当前可见、路径匹配的编辑器生效（切到别的文件不会乱画）
 */
export class FocusHighlighter implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private lastEditor: vscode.TextEditor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly log: Logger,
    private readonly durationMs = 5_000,
  ) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "1px",
      borderStyle: "dashed",
      borderColor: new vscode.ThemeColor("focusBorder"),
      overviewRulerColor: new vscode.ThemeColor("focusBorder"),
      overviewRulerLane: vscode.OverviewRulerLane?.Full ?? 4,
      backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
    });
  }

  /** 高亮某个 focus 范围；`focus` 为空等价于清除 */
  show(focus: FocusInfo | undefined): void {
    if (this.disposed) return;
    this.clear();

    if (!focus || !focus.path) return;
    const editor = findEditor(focus.path);
    if (!editor) {
      this.log.debug(`高亮跳过：没有打开 ${focus.path} 的可见编辑器`);
      return;
    }

    const range = new vscode.Range(
      Math.max(0, focus.startLine - 1),
      0,
      Math.max(0, focus.endLine - 1),
      editor.document.lineAt(Math.max(0, Math.min(focus.endLine - 1, editor.document.lineCount - 1))).text.length,
    );
    const label = focus.symbol ? `（函数 ${focus.symbol}）` : "";
    const hover = new vscode.MarkdownString(`Bee Code 读取了这段代码${label}：第 ${focus.startLine}-${focus.endLine} 行`);
    hover.isTrusted = false;

    try {
      editor.setDecorations(this.decoration, [{ range, hoverMessage: hover }]);
      this.lastEditor = editor;
      this.log.debug(`高亮 ${focus.path}:${focus.startLine}-${focus.endLine}`);
    } catch (err) {
      this.log.warn(`高亮失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (this.durationMs > 0) {
      this.timer = setTimeout(() => this.clear(), this.durationMs);
      this.timer.unref?.();
    }
  }

  /** 清掉上一处高亮（幂等） */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.lastEditor) {
      try {
        this.lastEditor.setDecorations(this.decoration, []);
      } catch {
        // 编辑器可能已关闭，忽略
      }
      this.lastEditor = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.decoration.dispose();
  }
}

/** 找到路径匹配的可见编辑器（focus.path 是工作区相对路径） */
export function findEditor(relativePath: string): vscode.TextEditor | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== "file") continue;
    if (toWorkspaceRelative(editor.document.uri.fsPath).replace(/\\/g, "/") === normalized) return editor;
  }
  return undefined;
}
