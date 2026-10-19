import * as vscode from "vscode";
import type { ChatViewProvider } from "../panel/chatViewProvider";
import type { Logger } from "../log";
import { toWorkspaceRelative } from "../paths";

/** 命令只依赖这个接口，不依赖 extension.ts 的内部实现（避免循环依赖） */
export interface CommandDeps {
  panel: ChatViewProvider;
  log: Logger;
  configureModel(): Promise<void>;
  restartCore(): Promise<void>;
  restoreCheckpoint(): Promise<void>;
  acceptAll(): Promise<void>;
  rejectAll(): Promise<void>;
  /** 重载中断后：让 agent 接着上次的工具调用继续 */
  continueTurn(): Promise<void>;
  /** 重载中断后：让 agent 重新生成提案 */
  regenerateProposal(): Promise<void>;
  /** 新建会话（当前会话的完整记录仍留在磁盘） */
  newSession(): Promise<void>;
  /** 从历史会话里挑一个继续 */
  pickSession(): Promise<void>;
  /** 清除「记住这次选择」里存下的确认项 */
  clearRemembered(): void;
  /** 取消「全部接受」的后续处理（已完成的不回滚） */
  cancelAcceptAll(): void;
  /** 仅 mock 模式：模拟内核崩溃，验证「内核挂了」的处理路径 */
  crashMock(): void;
  pickFiles(): Promise<void>;
  exportDiagnostics(): Promise<void>;
}

/**
 * 命令注册表。
 *
 * 每个命令都是薄薄一层：拿上下文 → 调 panel/deps。
 * `context.subscriptions` 统一兜底释放，避免扩展重载时残留监听。
 */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): string[] {
  const ids: string[] = [];
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    ids.push(id);
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        const startedAt = Date.now();
        try {
          await handler(...args);
          // 成功也留痕：用户说"点了没反应"时，这条 debug 是唯一线索
          deps.log.debug(`命令 ${id} 完成（${Date.now() - startedAt}ms）`);
        } catch (err) {
          const name = err instanceof Error ? err.name : "";
          const message = err instanceof Error ? err.message : String(err);
          if (name === "CancelledError") {
            // 用户主动取消不该弹红框
            deps.log.debug(`命令 ${id} 被取消`);
            return;
          }
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
  register("beeCode.confirm.resetRemembered", () => deps.clearRemembered());
  register("beeCode.session.new", () => deps.newSession());
  register("beeCode.session.pick", () => deps.pickSession());
  register("beeCode.session.continue", () => deps.continueTurn());
  register("beeCode.session.regenerate", () => deps.regenerateProposal());
  register("beeCode.proposal.acceptAll", () => deps.acceptAll());
  register("beeCode.proposal.cancelAcceptAll", () => deps.cancelAcceptAll());
  register("beeCode.proposal.rejectAll", () => deps.rejectAll());
  register("beeCode.checkpoint.restore", () => deps.restoreCheckpoint());
  register("beeCode.core.restart", () => deps.restartCore());
  register("beeCode.core.showOutput", () => deps.log.show());
  register("beeCode.exportDiagnostics", () => deps.exportDiagnostics());
  register("beeCode.dev.crashMock", () => deps.crashMock());

  return ids;
}

/**
 * 命令对账：已注册的 id ↔ `package.json` 里 `contributes.commands` 声明的 id。
 *
 * 两边不一致的后果很隐蔽：
 *   - 注册了但没声明 → 命令面板里看不到（只能靠快捷键/编程调用）
 *   - 声明了但没注册 → 用户点了报 `command not found`
 * 和协议契约（contract.json）一样，这类"两份清单"必须自动对账。
 */
export function undeclaredCommands(context: vscode.ExtensionContext, registered: string[]): string[] {
  const contributes = (context.extension?.packageJSON as { contributes?: { commands?: Array<{ command?: string }> } })
    ?.contributes;
  const declared = (contributes?.commands ?? [])
    .map((c) => c.command)
    .filter((id): id is string => typeof id === "string");

  const declaredSet = new Set(declared);
  const registeredSet = new Set(registered);
  const problems: string[] = [];
  for (const id of registeredSet) if (!declaredSet.has(id)) problems.push(`已注册但 package.json 未声明：${id}`);
  for (const id of declaredSet) if (!registeredSet.has(id)) problems.push(`package.json 已声明但未注册：${id}`);
  return problems;
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
  // 协议里路径一律工作区相对：绝对路径会把用户名/目录结构带进 prompt
  const untitled = doc.uri.scheme === "untitled";
  const relPath = untitled ? doc.uri.path.replace(/^\//, "") : toWorkspaceRelative(doc.uri.fsPath);

  const seen = new Set<string>();
  let added = 0;
  for (const selection of selections) {
    // 稍微扩一点上下文：只给半截 if 块，模型很难判断
    const startLine = Math.max(0, selection.start.line - 2);
    const endLine = Math.min(doc.lineCount - 1, selection.end.line + 2);
    const key = `${relPath}:${startLine}:${endLine}`;
    if (seen.has(key)) continue;   // 多光标重叠时别重复附加
    seen.add(key);

    const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    deps.panel.addAttachment({
      path: relPath,
      startLine: startLine + 1,
      endLine: endLine + 1,
      text: doc.getText(range),
      kind: "selection",
      // 未保存文档没有真实路径：标出来，内核就不会拿它去 fs.read
      untitled: untitled || undefined,
    });
    added += 1;
  }

  deps.panel.setMode(mode);
  deps.panel.reveal();
  deps.panel.setHint(`已附加 ${added} 段选区 · ${mode}`);
}
