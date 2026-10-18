import type * as vscode from "vscode";
import type {
  ChatSendParams,
  InitializeParams,
  InitializeResult,
  ModelReloadParams,
  ReviewAllParams,
  ReviewTargetParams,
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

  reviewKeep(params: ReviewTargetParams): Promise<void>;
  reviewUndo(params: ReviewTargetParams): Promise<void>;
  reviewKeepAll(params: ReviewAllParams): Promise<void>;
  reviewUndoAll(params: ReviewAllParams): Promise<void>;

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
  id: number;
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
