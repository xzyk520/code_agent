import * as vscode from "vscode";
import type { CoreApi, CoreExitHandler, CoreNotificationHandler, InboundRequestHandler } from "../coreApi";
import { cancelledError } from "../coreApi";
import type { Logger } from "../log";
import {
  isRequest,
  isResponse,
  PROTOCOL_VERSION,
  RpcError,
  rpcCodeFor,
  type ChatSendParams,
  type ContextSummarizeParams,
  type ContextSummarizeResult,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
  type ModelReloadParams,
  type ProposalDecideParams,
  type ProposalReadParams,
  type ProposalReadResult,
  type SessionAbortParams,
} from "../protocol";
import { ChildTransport } from "./transport";

export interface PythonCoreOptions {
  pythonPath: string;
  args: string[];
  cwd: string;
  /** Extra environment variables (PYTHONPATH / encoding related), merged with process.env */
  env?: Record<string, string>;
  logger: Logger;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** One chat turn may span several tool-call rounds, so allow a generous limit (implementation detail, not exposed to callers) */
const CHAT_TIMEOUT_MS = 30 * 60 * 1000;
/** Python cold start + importing dependencies can be slow, so allow plenty of time */
const INITIALIZE_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * The real kernel: child process + NDJSON JSON-RPC (bidirectional).
 *
 * Transport details live in `transport.ts`; this file only handles RPC semantics:
 *   - Outbound request tracking (pending): timeouts, reject everything when the process exits
 *   - Inbound request handling (inbound): AbortController + cancellation mapping
 *   - Lifecycle: start / initialize / shutdown (idempotent) / dispose (synchronous and forceful)
 *   - Secrets travel only in the initialize message over stdin, never through argv / environment
 */
export class PythonCore implements CoreApi {
  readonly kind = "python" as const;

  private readonly transport: ChildTransport;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<CoreNotificationHandler>();
  private readonly exitHandlers = new Set<CoreExitHandler>();
  private requestHandler: InboundRequestHandler | undefined;
  private readonly inbound = new Map<string, AbortController>();
  private disposed = false;
  /** Idempotency anchor for shutdown */
  private stopping: Promise<void> | undefined;

  constructor(private readonly opts: PythonCoreOptions) {
    this.transport = new ChildTransport({
      pythonPath: opts.pythonPath,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      logger: opts.logger,
    });
  }

  get alive(): boolean {
    return this.transport.alive && !this.disposed;
  }

  setRequestHandler(handler: InboundRequestHandler): void {
    this.requestHandler = handler;
  }

  start(): void {
    if (this.transport.started) return;
    this.stopping = undefined; // allow a graceful stop again after a restart
    this.transport.start({
      onLine: (line) => this.onLine(line),
      onError: (err) => this.failAll(new Error(`Failed to start the core: ${err.message}`)),
      onExit: (code, reason) => {
        this.failAll(new Error(`The core exited (${reason})`));
        for (const handler of this.exitHandlers) handler(code, reason);
      },
    });
  }

  // ───────────────────────── outbound ─────────────────────────

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    this.start();
    let result: InitializeResult;
    try {
      result = (await this.request(
        "initialize",
        { ...params, protocolVersion: PROTOCOL_VERSION },
        INITIALIZE_TIMEOUT_MS,
      )) as InitializeResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("RPC timeout")) {
        throw new Error(
          `The core did not finish initializing within ${Math.round(INITIALIZE_TIMEOUT_MS / 1000)}s: Python may be slow to start, dependencies may be missing, or pythonPath may be wrong. Original error: ${message}`,
        );
      }
      throw err;
    }
    if (!result || result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Protocol version mismatch: shell=${PROTOCOL_VERSION}, core=${result?.protocolVersion ?? "unknown"}. Reinstall the extension or sync beecode/ipc.py.`,
      );
    }
    return result;
  }

  chatSend(params: ChatSendParams): Promise<void> {
    return this.request("chat.send", params, CHAT_TIMEOUT_MS).then(() => undefined);
  }

  contextSummarize(params: ContextSummarizeParams): Promise<ContextSummarizeResult> {
    return this.request("context.summarize", params, 180_000).then((r) => r as ContextSummarizeResult);
  }

  proposalRead(params: ProposalReadParams): Promise<ProposalReadResult> {
    return this.request("proposal.read", params).then((r) => r as ProposalReadResult);
  }

  proposalDecide(params: ProposalDecideParams): Promise<void> {
    return this.request("proposal.decide", params).then(() => undefined);
  }

  /**
   * Cancel the current session.
   *
   * The order matters:
   *   1. Abort the shell-side inbound requests in flight first (the ones the kernel is waiting on us for)
   *   2. **Then reject the in-flight `chat.send`**: otherwise the shell waits for the 30-minute timeout,
   *      while the caller (extension) has already cleared busy -> the user can send another turn -> two
   *      agent loops run concurrently
   *   3. Finally notify the kernel (ignore failures; the process may already be gone)
   */
  async abort(sessionId: string): Promise<void> {
    for (const [key, controller] of this.inbound) {
      controller.abort();
      this.inbound.delete(key);
    }
    this.rejectPending("chat.send", cancelledError("The user cancelled this turn"));

    const params: SessionAbortParams = { sessionId };
    await this.request("session.abort", params, 10_000).catch(() => undefined);
  }

  modelReload(params: ModelReloadParams): Promise<void> {
    return this.request("model.reload", params).then(() => undefined);
  }

  /**
   * Graceful stop: send a `shutdown` request, let the peer exit on its own, kill if it times out.
   * Idempotent -- repeated calls return the same Promise, avoiding duplicated cleanup under concurrency.
   */
  shutdown(): Promise<void> {
    this.stopping ??= this.doShutdown();
    return this.stopping;
  }

  private async doShutdown(): Promise<void> {
    if (!this.transport.started) return;
    try {
      // Send shutdown before setting disposed: otherwise request() rejects immediately with "kernel not running" and nothing is notified
      await this.request("shutdown", {}, 3_000);
    } catch {
      /* The kernel may already have crashed; ignore */
    }
    this.disposed = true;
    this.transport.endInput();
    setTimeout(() => this.transport.kill(), 2_000).unref();
  }

  onNotification(handler: CoreNotificationHandler): vscode.Disposable {
    this.notificationHandlers.add(handler);
    return { dispose: () => this.notificationHandlers.delete(handler) };
  }

  onExit(handler: CoreExitHandler): vscode.Disposable {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  /**
   * Release resources: **synchronous**, best-effort, never throws, idempotent.
   * Division of labour with `shutdown()`: no waiting and no politeness here -- kill directly and clear callbacks.
   */
  dispose(): void {
    this.disposed = true;
    this.failAll(new Error("The core has been disposed"));
    this.transport.dispose();
    for (const controller of this.inbound.values()) controller.abort();
    this.inbound.clear();
    this.notificationHandlers.clear();
    this.exitHandlers.clear();
  }

  // ───────────────────────── inbound ─────────────────────────

  private onLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.opts.logger.warn("Unable to parse the core message (not JSON)", line.slice(0, 200));
      return;
    }

    if (isRequest(msg)) {
      void this.handleInbound(msg.id, msg.method, msg.params);
      return;
    }
    if (isResponse(msg)) {
      if (typeof msg.id !== "number") {
        // Request ids we send are always numbers; a string id from the peer is a peer bug, so do not drop it silently
        this.opts.logger.warn(`Received a response with a non-numeric id (${typeof msg.id}); ignoring it`);
        return;
      }
      this.settle("error" in msg ? { id: msg.id, error: msg.error } : { id: msg.id, result: msg.result });
      return;
    }
    const note = msg as { method?: string; params?: unknown };
    if (typeof note.method === "string") {
      this.handleNotification(note.method, note.params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "$/cancelRequest") {
      const id = (params as { id?: JsonRpcId } | undefined)?.id;
      if (id !== undefined) {
        const key = String(id);
        this.inbound.get(key)?.abort();
        this.inbound.delete(key);
      }
      return;
    }
    for (const handler of this.notificationHandlers) handler(method, params);
  }

  private async handleInbound(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) {
      void this.write({ jsonrpc: "2.0", id, error: { code: RpcError.METHOD_NOT_FOUND, message: "The shell has no registered request handler" } });
      return;
    }
    const controller = new AbortController();
    const key = String(id);
    this.inbound.set(key, controller);
    try {
      const result = await this.requestHandler(method, params, {
        id,
        signal: controller.signal,
        throwIfCancelled: () => {
          if (controller.signal.aborted) throw cancelledError();
        },
      });
      void this.write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (err) {
      const isCancel = err instanceof Error && err.name === "CancelledError";
      void this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: isCancel ? RpcError.SHELL_ERROR : rpcCodeFor(err),
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      this.inbound.delete(key);
    }
  }

  // ───────────────────────── low level ─────────────────────────

  private request(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.transport.alive) {
      return Promise.reject(new Error("The core is not running"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Also cancel the kernel-side work on timeout
        void this.notify("$/cancelRequest", { id });
        reject(new Error(`RPC timeout: ${method} (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      void this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonRpcMessage): Promise<void> {
    return this.transport.write(message);
  }

  private settle(msg: { id: number; result?: unknown; error?: JsonRpcErrorObject }): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`${pending.method}: ${msg.error.message} (code ${msg.error.code})`));
    } else {
      pending.resolve(msg.result);
    }
  }

  /** Reject every in-flight request for a given method immediately (used by abort; keeps callers from hanging until the timeout) */
  private rejectPending(method: string, err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.method !== method) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(err);
    }
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}
