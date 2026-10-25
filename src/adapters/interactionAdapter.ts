import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import type { ConfirmAskParams, ConfirmAskResult, SecretsGetParams, SecretsGetResult } from "../protocol";

/**
 * The two adapters that interact with the human.
 *
 * `secrets.get` should be called exactly once, during the handshake; afterwards the core should keep the secret in memory.
 * `confirm.ask` is where the write gate (sensitive files / large batches) is enforced.
 */

/**
 * Secret prefixes the core is allowed to read.
 *
 * Why a whitelist: `context.secrets` is this extension's namespace, and if other credentials
 * were stored later (a GitHub token, an MCP service key), a single `secrets.get` from the core
 * would reach them — and "the core does not need it" is something the shell must enforce,
 * not something that can rely on the core's self-restraint.
 */
const ALLOWED_SECRET_PREFIXES = ["beeCode.apiKey."];

/** Remembered choices are stored under this globalState key (an object: rememberKey → choiceId) */
const REMEMBERED_STATE_KEY = "beeCode.confirm.remembered";

/** Id of the appended "remember" pseudo-option */
const REMEMBER_ITEM_ID = "__remember__";
const PREVIEW_ITEM_ID = "__preview__";
const DETAIL_SCHEME = "beecode-confirm-detail";

/** Ids with negative meaning: if one is already there, no default "Cancel" is added */
const NEGATIVE_IDS = new Set(["no", "cancel", "reject", "abort", "deny", "skip"]);

export function createSecretAdapter(context: vscode.ExtensionContext, logger: Logger) {
  return {
    async get(params: SecretsGetParams): Promise<SecretsGetResult> {
      if (!isAllowedSecret(params.key)) {
        logger.warn(`secrets.get rejected (not in the allowlist): ${params.key}`);
        throw new Error(`Reading this secret is not allowed: ${params.key} (only the ${ALLOWED_SECRET_PREFIXES.join(", ")} prefix is allowed)`);
      }
      const value = await context.secrets.get(params.key);
      // The value must never be written to the log; record only "whether it is set"
      logger.debug(`secrets.get ${params.key} → ${value ? "configured" : "not configured"}`);
      return { value: value ?? null };
    },
  };
}

export function createConfirmAdapter(context: vscode.ExtensionContext, logger: Logger) {
  const detailText = new Map<string, string>();
  let detailSeq = 0;
  const detailRegistration = vscode.workspace.registerTextDocumentContentProvider(DETAIL_SCHEME, {
    provideTextDocumentContent: (uri) => detailText.get(uri.query) ?? "",
  });
  context.subscriptions.push(detailRegistration);

  async function showFullDetails(params: ConfirmAskParams): Promise<void> {
    const id = `detail-${++detailSeq}`;
    detailText.set(id, `${params.question}\n\n${params.detail ?? ""}`);
    const uri = vscode.Uri.from({ scheme: DETAIL_SCHEME, path: "/confirmation.md", query: id });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
  }

  async function closeFullDetails(): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== DETAIL_SCHEME) continue;
        try {
          await vscode.window.tabGroups.close(tab);
        } catch {
          /* already closed */
        }
      }
    }
    detailText.clear();
  }

  return {
    async ask(params: ConfirmAskParams, ctx: InboundRequestContext): Promise<ConfirmAskResult> {
      // 1) If it was "remembered" before, return directly without bothering the user
      if (params.rememberKey) {
        const remembered = readRemembered(context)[params.rememberKey];
        if (remembered && params.options.some((o) => o.id === remembered)) {
          logger.debug(`confirm.ask using remembered choice: ${params.rememberKey} → ${remembered}`);
          return { choice: remembered };
        }
      }

      const items = buildItems(params);
      let picked = await pick(items, params, ctx);
      while (picked?.id === PREVIEW_ITEM_ID) {
        await showFullDetails(params);
        picked = await pick(items, params, ctx);
      }

      // 2) Cancelled / interrupted by the core: always treat it as "the user did not agree"
      if (!picked) {
        await closeFullDetails();
        logger.debug(`confirm.ask cancelled: ${params.question}`);
        return { choice: null };
      }

      // 3) The user picked "remember this choice" → ask once more "remember which one", then store the result
      if (picked.id === REMEMBER_ITEM_ID && params.rememberKey) {
        const chosen = await pick(
          params.options.map((opt) => ({
            id: opt.id,
            label: opt.label,
            description: opt.description,
            detail: params.detail,
          })),
          params,
          ctx,
        );
        if (!chosen) { await closeFullDetails(); return { choice: null }; }
        await closeFullDetails();
        writeRemembered(context, params.rememberKey, chosen.id);
        logger.debug(`confirm.ask remember: ${params.rememberKey} → ${chosen.id}`);
        return { choice: chosen.id };
      }

      await closeFullDetails();
      logger.debug(`confirm.ask choice: ${picked.id}`);
      return { choice: picked.id };
    },
  };
}

// ───────────────────────── Internals ─────────────────────────

function isAllowedSecret(key: string): boolean {
  return ALLOWED_SECRET_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Build the options:
 *   - `detail` is attached to every option (QuickPick shows it under the selected row) — only then does the user know what they are confirming
 *   - when no option carries negative semantics, append "Cancel" as a fallback (a confirmation box with a single "Continue" button is an anti-pattern)
 *   - when `rememberKey` is given, append "Remember this choice"
 */
function buildItems(params: ConfirmAskParams): Array<vscode.QuickPickItem & { id: string }> {
  const items: Array<vscode.QuickPickItem & { id: string }> = params.options.map((opt) => ({
    id: opt.id,
    label: opt.label,
    description: opt.description,
    detail: params.detail,
  }));

  if (!params.options.some((opt) => NEGATIVE_IDS.has(opt.id.toLowerCase()))) {
    items.push({ id: "cancel", label: "Cancel", description: "Make no changes" });
  }
  if (params.detail && params.detail.length > 160) {
    items.push({
      id: PREVIEW_ITEM_ID,
      label: "View full details...",
      description: "Open the complete request in an editor (recommended for long commands)",
    });
  }
  if (params.rememberKey) {
    items.push({ id: REMEMBER_ITEM_ID, label: "Remember this choice...", description: "Don't ask again for the same action" });
  }
  return items;
}

/**
 * Show the picker, wiring in the core's cancellation signal.
 *
 * `showQuickPick`'s third parameter is a `CancellationToken`: when the core calls `session.abort` /
 * cancels this RPC, the popup must **vanish immediately**, otherwise the user is left staring at a confirmation box that is already void.
 */
async function pick(
  items: Array<vscode.QuickPickItem & { id: string }>,
  params: ConfirmAskParams,
  ctx: InboundRequestContext,
): Promise<(vscode.QuickPickItem & { id: string }) | undefined> {
  if (ctx.signal.aborted) return undefined;

  let source: vscode.CancellationTokenSource | undefined;
  let onAbort: (() => void) | undefined;
  try {
    source = new vscode.CancellationTokenSource();
    onAbort = () => source?.cancel();
    ctx.signal.addEventListener("abort", onAbort);
  } catch {
    source = undefined;   // very old versions / test environments lack CancellationTokenSource: degrade to non-cancellable
  }

  try {
    return await vscode.window.showQuickPick(items, {
      title: params.detail ? "Bee Code · Confirmation Required" : "Bee Code",
      placeHolder: params.question,
      ignoreFocusOut: true,
      matchOnDescription: true,
      canPickMany: false,
    }, source?.token);
  } finally {
    if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
    source?.dispose();
  }
}

function readRemembered(context: vscode.ExtensionContext): Record<string, string> {
  return context.globalState.get<Record<string, string>>(REMEMBERED_STATE_KEY) ?? {};
}

function writeRemembered(context: vscode.ExtensionContext, rememberKey: string, choice: string): void {
  const next = { ...readRemembered(context), [rememberKey]: choice };
  void context.globalState.update(REMEMBERED_STATE_KEY, next);
}

/** Used by the "Clear remembered choices" command */
export function clearRememberedChoices(context: vscode.ExtensionContext): void {
  void context.globalState.update(REMEMBERED_STATE_KEY, {});
}
