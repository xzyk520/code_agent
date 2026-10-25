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
    logger.warn("VS Code 判定当前工作区不受信任：禁写、禁命令");
    return false;
  }

  const map = context.globalState.get<TrustMap>(TRUST_KEY) ?? {};
  if (map[root] === true) return true;
  if (map[root] === false) {
    logger.info("工作区曾被标记为不信任：禁写、禁命令");
    return false;
  }

  const choice = await vscode.window.showWarningMessage(
    "Bee Code: 是否信任此工作区？\n\n" +
      "信任后允许 agent 修改文件（仍需你逐文件接受）与执行命令（按权限规则）。\n" +
      "不信任时只能读取与对话。",
    { modal: true },
    "信任",
    "只读",
  );

  const trusted = choice === "信任";
  await setTrust(context, root, trusted);
  logger.info(`工作区信任：${trusted ? "已信任" : "只读"}`);
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
    void vscode.window.showInformationMessage("Bee Code: 请先打开一个工作区。");
    return;
  }
  const current = isTrusted(context);
  await setTrust(context, root, !current);
  logger.info(`工作区信任切换为：${current ? "只读" : "已信任"}`);
  void vscode.window.showInformationMessage(
    current ? "Bee Code: 已取消信任（禁写、禁命令）。" : "Bee Code: 已信任此工作区。",
  );
}
