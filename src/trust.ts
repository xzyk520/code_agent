import * as vscode from "vscode";
import type { Logger } from "./log";

/**
 * 工作区信任：**我们自己的记录**，与 VS Code 的 Workspace Trust 叠加。
 *
 * 为什么要自己记：
 *   - VS Code 的信任粒度是"整个文件夹"，我们可能需要更细（只读 vs 可写）
 *   - 用户第一次打开陌生仓库时，我们也要问一次"是否允许它改文件/跑命令"
 *
 * 判定规则：
 *   - VS Code 判定不受信任 → 我们也不信任（不覆盖更严格的一侧）
 *   - VS Code 受信任但没有我们的记录 → 提示一次并记录
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
 * 启动时确保有信任记录。返回最终是否受信任。
 *
 * 只在"VS Code 已信任 + 我们没有记录"时问一次；用户拒绝会记录 false，
 * 之后可用命令「信任此工作区」改回来。
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

/** 供命令「信任此工作区 / 取消信任」使用 */
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
