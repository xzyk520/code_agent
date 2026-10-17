import * as vscode from "vscode";
import type { ChatViewProvider } from "../panel/chatViewProvider";
import type { Logger } from "../log";

/** 命令只依赖这个接口，不依赖 extension.ts 的内部实现（避免循环依赖） */
export interface CommandDeps {
  panel: ChatViewProvider;
  log: Logger;
  configureModel(): Promise<void>;
  restartCore(): Promise<void>;
  restoreCheckpoint(): Promise<void>;
  keepAll(): Promise<void>;
  undoAll(): Promise<void>;
  pickFiles(): Promise<void>;
}

/**
 * 命令注册表。
 *
 * 每个命令都是薄薄一层：拿上下文 → 调 panel/deps。
 * `context.subscriptions` 统一兜底释放，避免扩展重载时残留监听。
 */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.log.error(`命令 ${id} 失败: ${message}`);
          void vscode.window.showErrorMessage(`Bee Code: ${message}`);
        }
      }),
    );
  };

  register("beeCode.chat.ask", () => {
    deps.panel.reveal();
  });

  register("beeCode.selection.chat", (mode?: unknown) => attachSelection(deps, "chat", mode));
  register("beeCode.selection.build", (mode?: unknown) => attachSelection(deps, "builder", mode));
  register("beeCode.selection.debug", (mode?: unknown) => attachSelection(deps, "debugger", mode));

  register("beeCode.files.pick", () => deps.pickFiles());
  register("beeCode.model.configure", () => deps.configureModel());
  register("beeCode.review.keepAll", () => deps.keepAll());
  register("beeCode.review.undoAll", () => deps.undoAll());
  register("beeCode.checkpoint.restore", () => deps.restoreCheckpoint());
  register("beeCode.core.restart", () => deps.restartCore());
  register("beeCode.core.showOutput", () => deps.log.show());
}

async function attachSelection(
  deps: CommandDeps,
  mode: "chat" | "builder" | "debugger",
  _unused?: unknown,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    deps.panel.reveal();
    return;
  }

  // 只读文档（diff 侧、预览侧）不该出现在这里
  if (editor.document.uri.scheme !== "file" && editor.document.uri.scheme !== "untitled") {
    void vscode.window.showInformationMessage("Bee Code: 请在普通文件里选择代码。");
    return;
  }

  const selections = editor.selections.filter((s) => !s.isEmpty);
  if (selections.length === 0) {
    deps.panel.setMode(mode);
    deps.panel.reveal();
    return;
  }

  const doc = editor.document;
  for (const selection of selections) {
    // 稍微扩一点上下文：只给半截 if 块，模型很难判断
    const startLine = Math.max(0, selection.start.line - 2);
    const endLine = Math.min(doc.lineCount - 1, selection.end.line + 2);
    const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    deps.panel.addAttachment({
      path: doc.uri.fsPath,
      startLine: startLine + 1,
      endLine: endLine + 1,
      text: doc.getText(range),
      kind: "selection",
    });
  }

  deps.panel.setMode(mode);
  deps.panel.reveal();
  deps.panel.setHint(`已附加 ${selections.length} 段选区 · ${mode}`);
}
