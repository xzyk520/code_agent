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
  /** 追加的环境变量（PYTHONPATH / 编码相关），与 process.env 合并 */
  env?: Record<string, string>;
  logger: Logger;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** 一轮对话可能跨多轮工具调用，给宽松上限（实现自己决定，不暴露给调用方） */
const CHAT_TIMEOUT_MS = 30 * 60 * 1000;
/** Python 冷启动 + import 依赖可能很慢，给足时间 */
const INITIALIZE_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * 真实内核：子进程 + NDJSON JSON-RPC（双向）。
 *
 * 传输细节在 `transport.ts`；这里只负责 RPC 语义：
 *   - 出站请求跟踪（pending）：超时、进程退出时全部 reject
 *   - 入站请求处理（inbound）：AbortController + 取消映射
 *   - 生命周期：start / initialize / shutdown（幂等）/ dispose（同步暴力）
 *   - 密钥只通过 stdin 的 initialize 报文传入，不碰 argv / 环境变量
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
  /** shutdown 的幂等锚点 */
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
    this.stopping = undefined; // 允许重启后再次优雅停止
    this.transport.start({
      onLine: (line) => this.onLine(line),
      onError: (err) => this.failAll(new Error(`内核启动失败：${err.message}`)),
      onExit: (code, reason) => {
        this.failAll(new Error(`内核已退出（${reason}）`));
        for (const handler of this.exitHandlers) handler(code, reason);
      },
    });
  }

  // ───────────────────────── 出站 ─────────────────────────

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
      if (message.includes("RPC 超时")) {
        throw new Error(
          `内核在 ${Math.round(INITIALIZE_TIMEOUT_MS / 1000)}s 内没有完成初始化：可能是 Python 启动慢、依赖没装好，或 pythonPath 指错了。原始错误：${message}`,
        );
      }
      throw err;
    }
    if (!result || result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `协议版本不匹配：壳=${PROTOCOL_VERSION}，内核=${result?.protocolVersion ?? "未知"}。请重装扩展或同步 beecode/ipc.py。`,
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
   * 取消当前会话。
   *
   * 顺序很重要：
   *   1. 先 abort 壳侧在飞的入站请求（内核正在等我们干活的那些）
   *   2. **再 reject 在飞的 `chat.send`**：否则壳会一直等到 30 分钟超时，
   *      而调用方（extension）已经把 busy 复位了 → 用户可以再发一轮 → 两个 agent loop 并发
   *   3. 最后通知内核（失败就忽略，进程可能已经不在）
   */
  async abort(sessionId: string): Promise<void> {
    for (const [key, controller] of this.inbound) {
      controller.abort();
      this.inbound.delete(key);
    }
    this.rejectPending("chat.send", cancelledError("用户取消了本轮对话"));

    const params: SessionAbortParams = { sessionId };
    await this.request("session.abort", params, 10_000).catch(() => undefined);
  }

  modelReload(params: ModelReloadParams): Promise<void> {
    return this.request("model.reload", params).then(() => undefined);
  }

  /**
   * 优雅停止：发 `shutdown` 请求，等对端自己退，超时再 kill。
   * 幂等 —— 多次调用返回同一个 Promise，避免并发重复收尾。
   */
  shutdown(): Promise<void> {
    this.stopping ??= this.doShutdown();
    return this.stopping;
  }

  private async doShutdown(): Promise<void> {
    if (!this.transport.started) return;
    try {
      // 先发 shutdown 再置 disposed：否则 request() 会以"内核未运行"直接拒绝，等于没通知
      await this.request("shutdown", {}, 3_000);
    } catch {
      /* 内核可能已崩，忽略 */
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
   * 释放资源：**同步**、尽力而为、不抛错、幂等。
   * 与 `shutdown()` 的分工：这里不等待、不礼貌，直接 kill 并清空回调。
   */
  dispose(): void {
    this.disposed = true;
    this.failAll(new Error("内核已释放"));
    this.transport.dispose();
    for (const controller of this.inbound.values()) controller.abort();
    this.inbound.clear();
    this.notificationHandlers.clear();
    this.exitHandlers.clear();
  }

  // ───────────────────────── 入站 ─────────────────────────

  private onLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.opts.logger.warn("无法解析内核报文（不是 JSON）", line.slice(0, 200));
      return;
    }

    if (isRequest(msg)) {
      void this.handleInbound(msg.id, msg.method, msg.params);
      return;
    }
    if (isResponse(msg)) {
      if (typeof msg.id !== "number") {
        // 我们自己发的请求 id 都是 number；对端回了个 string id 就是对端 bug，不能静默丢
        this.opts.logger.warn(`收到非数字 id 的响应（${typeof msg.id}），已忽略`);
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
      void this.write({ jsonrpc: "2.0", id, error: { code: RpcError.METHOD_NOT_FOUND, message: "壳未注册请求处理器" } });
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

  // ───────────────────────── 底层 ─────────────────────────

  private request(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.transport.alive) {
      return Promise.reject(new Error("内核未运行"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时也顺手取消内核侧的工作
        void this.notify("$/cancelRequest", { id });
        reject(new Error(`RPC 超时：${method}（${Math.round(timeoutMs / 1000)}s）`));
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
      pending.reject(new Error(`${pending.method}: ${msg.error.message}（code ${msg.error.code}）`));
    } else {
      pending.resolve(msg.result);
    }
  }

  /** 把某个方法所有在飞请求立刻 reject（用于 abort；避免调用方挂到超时） */
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
