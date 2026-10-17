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
 * 内核的抽象。两种实现：
 *   - PythonCore（rpc/client.ts）：真实子进程，spawn `python -m beecode`
 *   - MockCore（dev/mockCore.ts）：进程内假内核，只用来调壳
 * 面板、命令、适配器**只依赖这个接口**，不关心背后是真 Python 还是 mock。
 */
export interface CoreApi extends vscode.Disposable {
  readonly mode: "python" | "mock";
  readonly alive: boolean;

  initialize(params: InitializeParams): Promise<InitializeResult>;
  chatSend(params: ChatSendParams, opts?: { timeoutMs?: number }): Promise<void>;
  reviewKeep(params: ReviewTargetParams): Promise<void>;
  reviewUndo(params: ReviewTargetParams): Promise<void>;
  reviewKeepAll(params: ReviewAllParams): Promise<void>;
  reviewUndoAll(params: ReviewAllParams): Promise<void>;
  abort(sessionId: string): Promise<void>;
  modelReload(params: ModelReloadParams): Promise<void>;
  shutdown(): Promise<void>;

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
