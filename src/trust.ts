import * as vscode from "vscode";
import type { Logger } from "./log";

/**
 * Workspace trust: **our own record**, layered on top of VS Code's Workspace Trust.
 *
 * Why keep our own record:
 *   - VS Code's trust granularity is "the whole folder", while we may need something finer (read-only vs writable)
 *   - When the user first opens an unfamiliar repository we also want to ask once "may it change files / run commands"
 *
 * Decision rules:
 *   - VS Code says untrusted -> we also do not trust (never override the stricter side)
 *   - VS Code trusts it but we have no record -> prompt once and record the answer
 */

const TRUST_KEY = "beeCode.trustedWorkspaces";

type TrustMap = Record<string, boolean>;

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function isTrusted(context: vscode.ExtensionContext): boolean {
  if (!vscode.workspace.isTrusted) return false;
  const root = workspaceRoot();
  if (!root) return false;
  const map = context.globalState.get<TrustMap>(TRUST_KEY) ?? {};
  return map[root] === true;
}

/**
 * Ensure a trust record exists at startup. Returns whether the workspace is ultimately trusted.
 *
 * It only asks once, when "VS Code trusts it + we have no record"; a refusal is recorded as false and can
 * later be changed back with the "Trust This Workspace" command.
 */
export async function ensureWorkspaceTrust(
  context: vscode.ExtensionContext,
  logger: Logger,
): Promise<boolean> {
  const root = workspaceRoot();
  if (!root) return false;

  if (!vscode.workspace.isTrusted) {
    logger.warn("VS Code reports the current workspace as untrusted: writes and commands are disabled");
    return false;
  }

  const map = context.globalState.get<TrustMap>(TRUST_KEY) ?? {};
  if (map[root] === true) return true;
  if (map[root] === false) {
    logger.info("The workspace was previously marked untrusted: writes and commands are disabled");
    return false;
  }

  const choice = await vscode.window.showWarningMessage(
    "Bee Code: Do you trust this workspace?\n\n" +
      "Trusting it allows the agent to modify files (you still accept each file) and run commands (subject to permission rules).\n" +
      "When untrusted, only reading and chat are available.",
    { modal: true },
    "Trust",
    "Read-only",
  );

  const trusted = choice === "Trust";
  await setTrust(context, root, trusted);
  logger.info(`Workspace trust: ${trusted ? "trusted" : "read-only"}`);
  return trusted;
}

export async function setTrust(
  context: vscode.ExtensionContext,
  root: string,
  trusted: boolean,
): Promise<void> {
  const map = { ...(context.globalState.get<TrustMap>(TRUST_KEY) ?? {}) };
  map[root] = trusted;
  await context.globalState.update(TRUST_KEY, map);
}

/** Used by the "Trust This Workspace / Revoke Trust" command */
export async function toggleWorkspaceTrust(
  context: vscode.ExtensionContext,
  logger: Logger,
): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showInformationMessage("Bee Code: Please open a workspace first.");
    return;
  }
  const current = isTrusted(context);
  await setTrust(context, root, !current);
  logger.info(`Workspace trust changed to: ${current ? "read-only" : "trusted"}`);
  void vscode.window.showInformationMessage(
    current ? "Bee Code: Trust revoked (writes and commands disabled)." : "Bee Code: This workspace is now trusted.",
  );
}
