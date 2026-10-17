import * as vscode from "vscode";
import type { Logger } from "../log";
import type { ConfirmAskParams, ConfirmAskResult, SecretsGetParams, SecretsGetResult } from "../protocol";

/**
 * 与人交互的两个适配器。
 *
 * `secrets.get` 只应在握手阶段被调用一次；之后内核应把密钥留在内存。
 * `confirm.ask` 是写入门闸（敏感文件 / 大批量）落地的地方。
 */

export function createSecretAdapter(context: vscode.ExtensionContext, logger: Logger) {
  return {
    async get(params: SecretsGetParams): Promise<SecretsGetResult> {
      const value = await context.secrets.get(params.key);
      // 绝不能把 value 写进日志，只能记「有没有」
      logger.debug(`secrets.get ${params.key} → ${value ? "已配置" : "未配置"}`);
      return { value: value ?? null };
    },
  };
}

export function createConfirmAdapter(logger: Logger) {
  return {
    async ask(params: ConfirmAskParams): Promise<ConfirmAskResult> {
      const items: Array<vscode.QuickPickItem & { id: string }> = params.options.map((opt) => ({
        id: opt.id,
        label: opt.label,
        description: opt.description,
      }));

      // 取消（Esc）返回 undefined —— 内核要把「用户没说 yes」当作拒绝，而不是继续
      const picked = await vscode.window.showQuickPick(items, {
        title: "Bee Code",
        placeHolder: params.question,
        ignoreFocusOut: true,
        matchOnDescription: true,
        canPickMany: false,
      });
      if (!picked) {
        logger.debug(`confirm.ask 被取消: ${params.question}`);
        return { choice: null };
      }
      logger.debug(`confirm.ask 选择: ${picked.id}`);
      return { choice: picked.id };
    },
  };
}
