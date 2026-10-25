import type * as vscode from "vscode";
import type {
  ChatSendParams,
  ContextSummarizeParams,
  ContextSummarizeResult,
  InitializeParams,
  InitializeResult,
  JsonRpcId,
  ModelReloadParams,
  ProposalDecideParams,
  ProposalReadParams,
  ProposalReadResult,
} from "./protocol";

/**
 * Kind of kernel implementation. Adding a new implementation (remote / sidecar / wasm) means
 * changing **only this line**; consumers take the type from `CoreApi["kind"]` and need not change.
 */
export type CoreKind = "python" | "mock";

/**
 * Abstraction over the kernel. Two implementations:
 *   - PythonCore (rpc/client.ts): a real child process, spawning `python -m beecode`
 *   - MockCore (dev/mockCore.ts): an in-process fake kernel, only for exercising the shell
 * The panel, commands and adapters **depend only on this interface** and do not care whether a real
 * Python kernel or a mock sits behind it.
 *
 * Lifecycle contract (the two methods have non-overlapping semantics that implementations must honour):
 *   - `shutdown()`: **graceful** stop. Send a `shutdown` request, let the peer exit on its own, kill on
 *     timeout. Idempotent (repeated calls return the same Promise).
 *   - `dispose()`: **release**. Synchronous, best-effort, never throws, idempotent. Kills the child
 *     process directly and clears callbacks; everything must reject afterwards.
 *   Callers usually `await shutdown()` and then `dispose()`; calling only `dispose()` must also be safe.
 */
export interface CoreApi extends vscode.Disposable {
  readonly kind: CoreKind;
  readonly alive: boolean;

  initialize(params: InitializeParams): Promise<InitializeResult>;

  /** One chat turn; **resolves only after the whole turn finishes**. Token deltas come through `ui.delta` notifications. The timeout policy is up to the implementation. */
  chatSend(params: ChatSendParams): Promise<void>;

  /**
   * Fetch the proposal body (virtual file content).
   *
   * Why "pull" instead of "push": notifications carry only metadata, while bodies can be hundreds of
   * KB and are needed only when the user actually wants to see the diff or accept it.
   */
  proposalRead(params: ProposalReadParams): Promise<ProposalReadResult>;

  /** Ask the kernel to generate a summary per turn with the model (used for context compaction) */
  contextSummarize(params: ContextSummarizeParams): Promise<ContextSummarizeResult>;

  /**
   * Tell the kernel the user's decision about a proposal.
   *
   * Ordering convention: **the shell persists first (successfully), then calls this method**. The
   * kernel cleans up / records the proposal based on it; the reverse is not allowed (kernel deletes
   * the proposal first and then the shell's write fails = the change vanishes into thin air).
   */
  proposalDecide(params: ProposalDecideParams): Promise<void>;

  /** Cancel the current session (interrupt in-flight requests + in-flight tools); this does not stop the kernel. */
  abort(sessionId: string): Promise<void>;

  /** The user changed the model config: hot-reload instead of restarting the process for one field. */
  modelReload(params: ModelReloadParams): Promise<void>;

  shutdown(): Promise<void>;
  dispose(): void;

  onNotification(handler: CoreNotificationHandler): vscode.Disposable;
  onExit(handler: CoreExitHandler): vscode.Disposable;
}

export type CoreNotificationHandler = (method: string, params: unknown) => void;
export type CoreExitHandler = (code: number | null, reason: string) => void;

/** After receiving `$/cancelRequest` the kernel should interrupt the RPC with that id; after receiving abort the shell cancels all in-flight requests */
export interface InboundRequestContext {
  /** Request id sent by the peer (kernel); it must be echoed back unchanged in the response; may be a number or a string */
  id: JsonRpcId;
  signal: AbortSignal;
  /** Thrown when already cancelled; adapters can use it to return early */
  throwIfCancelled(): void;
}

export type InboundRequestHandler = (
  method: string,
  params: unknown,
  ctx: InboundRequestContext,
) => Promise<unknown>;

export function cancelledError(message = "request cancelled"): Error {
  const err = new Error(message);
  err.name = "CancelledError";
  return err;
}
