import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import type { ConfirmAskParams, ConfirmAskResult, SecretsGetParams, SecretsGetResult } from "../protocol";

/**
 * 与人交互的两个适配器。
 *
 * `secrets.get` 只应在握手阶段被调用一次；之后内核应把密钥留在内存。
 * `confirm.ask` 是写入门闸（敏感文件 / 大批量）落地的地方。
 */

/**
 * 允许内核读取的密钥前缀。
 *
 * 为什么要有白名单：`context.secrets` 是本扩展的命名空间，将来如果存了别的凭据
 * （GitHub token、MCP 服务 key），内核一句 `secrets.get` 就能拿到——而"内核不需要"
 * 这件事应该由壳来守，不能靠内核对自觉。
 */
const ALLOWED_SECRET_PREFIXES = ["beeCode.apiKey."];

/** 记住的选择存在 globalState 的这个 key 下（对象：rememberKey → choiceId） */
const REMEMBERED_STATE_KEY = "beeCode.confirm.remembered";

/** 追加的"记住"伪选项 id */
const REMEMBER_ITEM_ID = "__remember__";

/** 否定语义的 id：已经有就不再加默认"取消" */
const NEGATIVE_IDS = new Set(["no", "cancel", "reject", "abort", "deny", "skip"]);

export function createSecretAdapter(context: vscode.ExtensionContext, logger: Logger) {
  return {
    async get(params: SecretsGetParams): Promise<SecretsGetResult> {
      if (!isAllowedSecret(params.key)) {
        logger.warn(`secrets.get 被拒绝（不在白名单）：${params.key}`);
        throw new Error(`不允许读取该密钥：${params.key}（只允许 ${ALLOWED_SECRET_PREFIXES.join(", ")} 前缀）`);
      }
      const value = await context.secrets.get(params.key);
      // 绝不能把 value 写进日志，只能记「有没有」
      logger.debug(`secrets.get ${params.key} → ${value ? "已配置" : "未配置"}`);
      return { value: value ?? null };
    },
  };
}

export function createConfirmAdapter(context: vscode.ExtensionContext, logger: Logger) {
  return {
    async ask(params: ConfirmAskParams, ctx: InboundRequestContext): Promise<ConfirmAskResult> {
      // ① 之前"记住"过就直接返回，不再打扰用户
      if (params.rememberKey) {
        const remembered = readRemembered(context)[params.rememberKey];
        if (remembered && params.options.some((o) => o.id === remembered)) {
          logger.debug(`confirm.ask 使用已记住的选择: ${params.rememberKey} → ${remembered}`);
          return { choice: remembered };
        }
      }

      const items = buildItems(params);
      const picked = await pick(items, params, ctx);

      // ② 取消 / 被内核中断：一律视为"用户没有同意"
      if (!picked) {
        logger.debug(`confirm.ask 被取消: ${params.question}`);
        return { choice: null };
      }

      // ③ 用户选择"记住这次选择"→ 再问一次"记住哪个"，然后把结果存下来
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
        if (!chosen) return { choice: null };
        writeRemembered(context, params.rememberKey, chosen.id);
        logger.debug(`confirm.ask 记住: ${params.rememberKey} → ${chosen.id}`);
        return { choice: chosen.id };
      }

      logger.debug(`confirm.ask 选择: ${picked.id}`);
      return { choice: picked.id };
    },
  };
}

// ───────────────────────── 内部 ─────────────────────────

function isAllowedSecret(key: string): boolean {
  return ALLOWED_SECRET_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * 构造选项：
 *   - `detail` 挂到每个选项上（QuickPick 会在选中行下方显示）——用户才知道自己在确认什么
 *   - 没有否定语义选项时，兜底追加"取消"（只有一个"继续"按钮的确认框是反模式）
 *   - 提供 `rememberKey` 时追加"记住这次选择"
 */
function buildItems(params: ConfirmAskParams): Array<vscode.QuickPickItem & { id: string }> {
  const items: Array<vscode.QuickPickItem & { id: string }> = params.options.map((opt) => ({
    id: opt.id,
    label: opt.label,
    description: opt.description,
    detail: params.detail,
  }));

  if (!params.options.some((opt) => NEGATIVE_IDS.has(opt.id.toLowerCase()))) {
    items.push({ id: "cancel", label: "取消", description: "不做任何修改" });
  }
  if (params.rememberKey) {
    items.push({ id: REMEMBER_ITEM_ID, label: "记住这次选择…", description: "下次同一操作不再询问" });
  }
  return items;
}

/**
 * 弹出选择框，并把内核的取消信号接进来。
 *
 * `showQuickPick` 的第三个参数是 `CancellationToken`：内核 `session.abort` /
 * 取消这个 RPC 时，弹窗必须**立刻消失**，否则用户面前会挂着一个已经无效的确认框。
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
    source = undefined;   // 极老版本 / 测试环境没有 CancellationTokenSource：退化为不可取消
  }

  try {
    return await vscode.window.showQuickPick(items, {
      title: params.detail ? "Bee Code · 需要确认" : "Bee Code",
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

/** 供「清除已记住的选择」命令使用 */
export function clearRememberedChoices(context: vscode.ExtensionContext): void {
  void context.globalState.update(REMEMBERED_STATE_KEY, {});
}
