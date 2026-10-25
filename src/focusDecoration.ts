import * as vscode from "vscode";
import type { FocusInfo } from "./focus";
import type { Logger } from "./log";
import { toWorkspaceRelative } from "./paths";

/**
 * Implicit selection highlighting: draws "which section the agent actually read" in the editor.
 *
 * Why it is needed: for automatically attached code the user cannot see the range in the panel (only a
 * one-line hint), so without drawing it there is no way to tell "did it look at the wrong place".
 *
 * Behaviour:
 *   - On send/attach, highlight the corresponding line range in the editor (dashed border + overview ruler)
 *   - Fades out automatically after 5 seconds; the next highlight clears the previous one first
 *   - Only applies to the currently visible editor whose path matches (switching to another file does not draw randomly)
 */
export class FocusHighlighter implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  /** Ranges the agent has read: stackable, and fainter than "the user's cursor" */
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
   * The agent read some file through a tool.
   *
   * Returns true = the editor is open and the range was drawn; false = the file is not open (or no range
   * was given), in which case the caller should degrade to a "file name highlight" (panel chip).
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
    // Keep only one entry for a repeated read of the same range; cap the total to avoid too many decorations
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

  /** Clear all "agent read" highlights */
  clearReads(): void {
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
    for (const [key, entry] of this.readState) {
      try {
        entry.editor.setDecorations(this.readDecoration, []);
      } catch {
        // The editor has been closed
      }
      this.readState.delete(key);
    }
  }

  /** Highlight a focus range; an empty `focus` is equivalent to clearing */
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

  /** Clear the previous highlight (idempotent) */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.lastEditor) {
      try {
        this.lastEditor.setDecorations(this.decoration, []);
      } catch {
        // The editor may have been closed; ignore
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

/** Find the visible editor whose path matches (focus.path is a workspace-relative path) */
export function findEditor(relativePath: string): vscode.TextEditor | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== "file") continue;
    if (toWorkspaceRelative(editor.document.uri.fsPath).replace(/\\/g, "/") === normalized) return editor;
  }
  return undefined;
}
