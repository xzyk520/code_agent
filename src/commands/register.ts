import * as vscode from "vscode";
import type { ChatViewProvider } from "../panel/chatViewProvider";
import type { Logger } from "../log";
import { toWorkspaceRelative } from "../paths";
import { readFocusForSelection } from "../focus";

/** Commands depend only on this interface, not on extension.ts internals (avoids circular dependencies) */
export interface CommandDeps {
  panel: ChatViewProvider;
  log: Logger;
  configureModel(): Promise<void>;
  restartCore(): Promise<void>;
  restoreCheckpoint(): Promise<void>;
  acceptAll(): Promise<void>;
  rejectAll(): Promise<void>;
  /** After an interrupted reload: let the agent continue from the last tool call */
  continueTurn(): Promise<void>;
  /** After an interrupted reload: ask the agent to regenerate the proposal */
  regenerateProposal(): Promise<void>;
  /** Start a new session (the full record of the current session stays on disk) */
  newSession(): Promise<void>;
  /** Pick a past session to continue */
  pickSession(): Promise<void>;
  /** Clear the remembered approvals stored by "remember this choice" */
  clearRemembered(): void;
  /** Cancel the remaining work of "accept all" (already-completed items are not rolled back) */
  cancelAcceptAll(): void;
  /** Mock mode only: simulate a core crash to exercise the "core died" handling path */
  crashMock(): void;
  /** Test model endpoint connectivity (GET /models) */
  testModel(): Promise<void>;
  /** Configure the subagent (endpoint/model/key; leave blank to inherit from the main agent) */
  configureSubagent(): Promise<void>;
  configureSummary(): Promise<void>;
  /** Test subagent endpoint connectivity */
  testSubagent(): Promise<void>;
  /** Clear the subagent key */
  clearSubagentKey(): Promise<void>;
  /** Toggle the current workspace trust state (trusted ⇄ read-only) */
  toggleTrust(): Promise<void>;
  /** Re-detect the docker sandbox (no need to restart the window after installing Docker) */
  redetectSandbox(): Promise<void>;
  /** Clear the API key stored in the credential store */
  clearModelKey(): Promise<void>;
  pickFiles(): Promise<void>;
  /** Read strategy for code near the cursor (used by the attach-selection commands) */
  focus: { fallbackLines: number; maxLines: number };
  /** Highlight in the editor the ranges the agent actually read */
  highlightFocus(focus: import("../focus").FocusInfo | undefined): void;
  exportDiagnostics(): Promise<void>;
  /** Choose the user-visible UI language (zh/en). */
  switchLanguage(): Promise<void>;
}

/**
 * Command registry.
 *
 * Each command is a thin layer: take the context, then call panel/deps.
 * `context.subscriptions` handles disposal centrally so no listeners leak on extension reload.
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
          // Log success too: when a user says "nothing happened", this debug line is the only clue
          deps.log.debug(`Command ${id} completed in ${Date.now() - startedAt}ms`);
        } catch (err) {
          const name = err instanceof Error ? err.name : "";
          const message = err instanceof Error ? err.message : String(err);
          if (name === "CancelledError") {
            // A user-initiated cancellation should not show a red error box
            deps.log.debug(`Command ${id} cancelled`);
            return;
          }
          deps.log.error(`Command ${id} failed: ${message}`);
          void vscode.window.showErrorMessage(`Bee Code: ${message}`);
        }
      }),
    );
  };

  register("beeCode.ui.language.switch", () => deps.switchLanguage());

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
  register("beeCode.model.test", () => deps.testModel());
  register("beeCode.subagent.configure", () => deps.configureSubagent());
  register("beeCode.summary.configure", () => deps.configureSummary());
  register("beeCode.subagent.test", () => deps.testSubagent());
  register("beeCode.subagent.clearKey", () => deps.clearSubagentKey());
  register("beeCode.workspace.trust", () => deps.toggleTrust());
  register("beeCode.docker.redetect", () => deps.redetectSandbox());
  register("beeCode.model.clearKey", () => deps.clearModelKey());

  return ids;
}

/**
 * Command reconciliation: registered ids ↔ ids declared in `contributes.commands` of `package.json`.
 *
 * Mismatches fail quietly:
 *   - Registered but not declared → invisible in the Command Palette (only reachable via keybinding/programmatic call)
 *   - Declared but not registered → clicking it reports `command not found`
 * Like the protocol contract (contract.json), these "two lists" must be reconciled automatically.
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
  for (const id of registeredSet) if (!declaredSet.has(id)) problems.push(`Registered but not declared in package.json: ${id}`);
  for (const id of declaredSet) if (!registeredSet.has(id)) problems.push(`Declared in package.json but not registered: ${id}`);
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

  // Read-only documents (diff/preview sides) should not reach this point
  if (editor.document.uri.scheme !== "file" && editor.document.uri.scheme !== "untitled") {
    void vscode.window.showInformationMessage("Bee Code: 请在普通文件里选择代码。");
    return;
  }

  const selections = editor.selections.length > 0 ? editor.selections : [editor.selection];

  const seen = new Set<string>();
  let added = 0;
  let functions = 0;
  for (const selection of selections) {
    // With a selection: expand to the whole function if the entire selection lies inside it; without one: take the whole function at the cursor
    const focus = await readFocusForSelection(editor, selection, {
      fallbackLines: deps.focus.fallbackLines,
      maxLines: deps.focus.maxLines,
    });
    if (!focus) continue;

    const key = `${focus.path}:${focus.startLine}:${focus.endLine}`;
    if (seen.has(key)) continue;   // Do not attach duplicates when multiple cursors overlap
    seen.add(key);

    deps.panel.addAttachment({
      path: focus.path,
      startLine: focus.startLine,
      endLine: focus.endLine,
      text: focus.text,
      kind: "focus",
      ...(focus.symbol ? { symbol: focus.symbol } : {}),
      // Unsaved documents have no real path: flag it so the core will not pass it to fs.read
      untitled: focus.untitled,
    });
    added += 1;
    if (focus.kind === "function") functions += 1;
    // Highlight the last attached range (with multiple cursors, highlight only the last one to avoid visual clutter)
    deps.highlightFocus(focus);
  }

  deps.panel.reveal();
  if (added === 0) {
    deps.panel.setHint("没有可附加的代码（光标不在文件里？）");
    return;
  }
  deps.panel.setHint(`已附加 ${added} 段（${functions} 个完整函数）· 模式由意图分析决定`);
}
