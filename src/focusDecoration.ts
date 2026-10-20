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
  /** agent 读取过的范围：可叠加，颜色比"用户光标"更淡 */
  private readonly readDecoration: vscode.TextEditorDecorationType;
  private lastEditor: vscode.TextEditor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly readState = new Map<string, { editor: vscode.TextEditor; ranges: vscode.Range[] }>();
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
    this.readDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane?.Full ?? 4,
      backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
    });
  }

  /**
   * agent 通过工具读了某个文件。
   *
   * 返回 true = 编辑器打开着、范围已画；false = 文件没打开（或没给范围），
   * 调用方应退化为"文件名高亮"（面板 chip）。
   */
  addRead(info: { path: string; startLine?: number; endLine?: number }): boolean {
    if (this.disposed) return false;
    if (!info.path || !info.startLine || !info.endLine) return false;
    const editor = findEditor(info.path);
    if (!editor) return false;

    const start = Math.max(0, info.startLine - 1);
    const end = Math.max(0, Math.min(info.endLine - 1, editor.document.lineCount - 1));
    const range = new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length);
    const key = editor.document.uri.fsPath;
    const entry = this.readState.get(key) ?? { editor, ranges: [] };
    // 同一范围重复读时只保留一条；总数封顶，避免装饰过多
    if (!entry.ranges.some((r) => r.start.line === range.start.line && r.end.line === range.end.line)) {
      entry.ranges.push(range);
      if (entry.ranges.length > 12) entry.ranges.shift();
    }
    entry.editor.setDecorations(this.readDecoration, entry.ranges);
    this.readState.set(key, entry);

    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => this.clearReads(), 6_000);
    this.readTimer.unref?.();
    return true;
  }

  /** 清掉所有"agent 读取"高亮 */
  clearReads(): void {
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
    for (const [key, entry] of this.readState) {
      try {
        entry.editor.setDecorations(this.readDecoration, []);
      } catch {
        // 编辑器已关闭
      }
      this.readState.delete(key);
    }
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
    this.clearReads();
    this.decoration.dispose();
    this.readDecoration.dispose();
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
