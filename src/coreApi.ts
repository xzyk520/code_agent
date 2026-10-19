import type * as vscode from "vscode";
import type {
  ChatSendParams,
  InitializeParams,
  InitializeResult,
  JsonRpcId,
  ModelReloadParams,
  ProposalDecideParams,
  ProposalReadParams,
  ProposalReadResult,
} from "./protocol";

/**
 * 内核实现种类。新增实现（remote / sidecar / wasm）时**只改这一行**，
 * 消费方通过 `CoreApi["kind"]` 取类型，不必跟着改。
 */
export type CoreKind = "python" | "mock";

/**
 * 内核的抽象。两种实现：
 *   - PythonCore（rpc/client.ts）：真实子进程，spawn `python -m beecode`
 *   - MockCore（dev/mockCore.ts）：进程内假内核，只用来调壳
 * 面板、命令、适配器**只依赖这个接口**，不关心背后是真 Python 还是 mock。
 *
 * 生命周期契约（两个方法语义不重叠，实现必须遵守）：
 *   - `shutdown()`：**优雅**停止。发 `shutdown` 请求、等对端自己退、超时再 kill。幂等（多次调用返回同一 Promise）。
 *   - `dispose()`：**释放**。同步、尽力而为、绝不抛错、幂等。直接 kill 子进程并清理回调，之后所有方法都应 reject。
 *   调用方通常 `await shutdown()` 再 `dispose()`；只调 `dispose()` 也必须是安全的。
 */
export interface CoreApi extends vscode.Disposable {
  readonly kind: CoreKind;
  readonly alive: boolean;

  initialize(params: InitializeParams): Promise<InitializeResult>;

  /** 一轮对话，**整轮结束后才 resolve**；token 增量走 `ui.delta` 通知。超时策略由实现自己决定。 */
  chatSend(params: ChatSendParams): Promise<void>;

  /**
   * 拉取提案正文（虚拟文件内容）。
   *
   * 为什么用"拉"而不是"推"：通知里只放元数据，正文可能几百 KB，
   * 只有用户真的要看 diff 或接受时才需要它。
   */
  proposalRead(params: ProposalReadParams): Promise<ProposalReadResult>;

  /**
   * 告知内核用户对某个提案的决定。
   *
   * 时序约定：**壳先落盘（成功）再调用本方法**。内核据此清理/记录提案，
   * 不允许反过来（内核先删提案、壳写盘失败 = 改动凭空消失）。
   */
  proposalDecide(params: ProposalDecideParams): Promise<void>;

  /** 取消当前会话（中断在飞请求 + 在飞工具），不是停止内核。 */
  abort(sessionId: string): Promise<void>;

  /** 用户改了模型配置：热更新，避免为改一个字段重启进程。 */
  modelReload(params: ModelReloadParams): Promise<void>;

  shutdown(): Promise<void>;
  dispose(): void;

  onNotification(handler: CoreNotificationHandler): vscode.Disposable;
  onExit(handler: CoreExitHandler): vscode.Disposable;
}

export type CoreNotificationHandler = (method: string, params: unknown) => void;
export type CoreExitHandler = (code: number | null, reason: string) => void;

/** 内核收到 `$/cancelRequest` 后应中断对应 id 的 RPC；壳收到 abort 后取消所有在飞请求 */
export interface InboundRequestContext {
  /** 对端（内核）发来的请求 id，回包时必须原样带回；可能是 number 或 string */
  id: JsonRpcId;
  signal: AbortSignal;
  /** 已被取消时抛这个；适配器里可据此提前返回 */
  throwIfCancelled(): void;
}

export type InboundRequestHandler = (
  method: string,
  params: unknown,
  ctx: InboundRequestContext,
) => Promise<unknown>;

export function cancelledError(): Error {
  const err = new Error("request cancelled");
  err.name = "CancelledError";
  return err;
}
