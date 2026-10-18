import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as vscode from "vscode";
import type { CoreApi, CoreExitHandler, CoreNotificationHandler, InboundRequestHandler } from "../coreApi";
import { cancelledError } from "../coreApi";
import type { Logger } from "../log";
import {
  isRequest,
  LineReader,
  PROTOCOL_VERSION,
  RpcError,
  type ChatSendParams,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcErrorObject,
  type JsonRpcMessage,
  type ModelReloadParams,
  type ReviewAllParams,
  type ReviewTargetParams,
} from "../protocol";

export interface PythonCoreOptions {
  pythonPath: string;
  args: string[];
  cwd: string;
  /** 追加的环境变量（PYTHONPATH / 编码相关），与 process.env 合并 */
  env?: Record<string, string>;
  logger: Logger;
}

/** chat.send 可能跑很久（多轮工具调用），给它一个宽松上限 */
const DEFAULT_TIMEOUT_MS = 120_000;
const CHAT_TIMEOUT_MS = 30 * 60_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * 真实内核：子进程 + NDJSON JSON-RPC。
 *
 * 三件事必须做对，否则会很难查：
 *   1. 残行缓存（一次 data 事件不保证是整数行）
 *   2. 所有 in-flight 请求在进程退出时 reject（否则 UI 永远转圈）
 *   3. 密钥只通过 stdin 的 initialize 报文传入，不碰 argv / 环境变量
 */
export class PythonCore implements CoreApi {
  readonly mode = "python" as const;

  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<CoreNotificationHandler>();
  private readonly exitHandlers = new Set<CoreExitHandler>();
  private requestHandler: InboundRequestHandler | undefined;
  private inbound = new Map<number, AbortController>();
  private disposed = false;

  constructor(private readonly opts: PythonCoreOptions) {}

  get alive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.disposed;
  }

  setRequestHandler(handler: InboundRequestHandler): void {
    this.requestHandler = handler;
  }

  start(): void {
    if (this.child) return;
    const { pythonPath, args, cwd, logger } = this.opts;
    logger.info(`启动内核: ${pythonPath} ${args.join(" ")} (cwd=${cwd})`);

    const child = spawn(pythonPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // PYTHONPATH（定位 beecode 包）+ 编码相关；密钥仍走 stdin 报文，不进程环境
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    const reader = new LineReader((line) => this.onLine(line));
    child.stdout.on("data", (chunk: string) => reader.push(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => logger.coreStderr(chunk));

    child.on("error", (err) => {
      logger.error(`内核进程启动失败: ${err.message}`);
      this.failAll(new Error(`内核启动失败：${err.message}`));
    });

    child.on("exit", (code, signal) => {
      reader.flush();
      const reason = signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
      logger.warn(`内核进程退出（${reason}）`);
      this.child = undefined;
      this.failAll(new Error(`内核已退出（${reason}）`));
      for (const handler of this.exitHandlers) handler(code, reason);
    });
  }

  // ───────────────────────── 出站 ─────────────────────────

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    this.start();
    const result = (await this.request("initialize", { ...params, protocolVersion: PROTOCOL_VERSION }, 20_000)) as InitializeResult | undefined;
    if (!result || result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `协议版本不匹配：壳=${PROTOCOL_VERSION}，内核=${result?.protocolVersion ?? "未知"}。请重装扩展或同步 beecode/ipc.py。`,
      );
    }
    return result;
  }

  chatSend(params: ChatSendParams, opts?: { timeoutMs?: number }): Promise<void> {
    return this.request("chat.send", params, opts?.timeoutMs ?? CHAT_TIMEOUT_MS).then(() => undefined);
  }

  reviewKeep(params: ReviewTargetParams): Promise<void> {
    return this.request("review.keep", params).then(() => undefined);
  }

  reviewUndo(params: ReviewTargetParams): Promise<void> {
    return this.request("review.undo", params).then(() => undefined);
  }

  reviewKeepAll(params: ReviewAllParams): Promise<void> {
    return this.request("review.keepAll", params).then(() => undefined);
  }

  reviewUndoAll(params: ReviewAllParams): Promise<void> {
    return this.request("review.undoAll", params).then(() => undefined);
  }

  abort(sessionId: string): Promise<void> {
    // 先取消本地所有在飞的 inbound（适配器），再通知内核
    for (const [id, controller] of this.inbound) {
      controller.abort();
      this.inbound.delete(id);
    }
    return this.request("session.abort", { sessionId }, 10_000).then(() => undefined).catch(() => undefined);
  }

  modelReload(params: ModelReloadParams): Promise<void> {
    return this.request("model.reload", params).then(() => undefined);
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    this.disposed = true;
    try {
      await this.request("shutdown", {}, 3_000);
    } catch {
      /* 内核可能已崩，忽略 */
    }
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 2_000).unref();
    }
  }

  onNotification(handler: CoreNotificationHandler): vscode.Disposable {
    this.notificationHandlers.add(handler);
    return { dispose: () => this.notificationHandlers.delete(handler) };
  }

  onExit(handler: CoreExitHandler): vscode.Disposable {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  dispose(): void {
    void this.shutdown();
    this.failAll(new Error("内核已释放"));
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
    const maybeResponse = msg as { id?: unknown; result?: unknown; error?: JsonRpcErrorObject };
    if (typeof maybeResponse.id === "number") {
      this.settle({ id: maybeResponse.id, result: maybeResponse.result, error: maybeResponse.error });
      return;
    }
    const note = msg as { method?: string; params?: unknown };
    if (typeof note.method === "string") {
      this.handleNotification(note.method, note.params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "$/cancelRequest") {
      const id = (params as { id?: number } | undefined)?.id;
      if (typeof id === "number") {
        this.inbound.get(id)?.abort();
        this.inbound.delete(id);
      }
      return;
    }
    for (const handler of this.notificationHandlers) handler(method, params);
  }

  private async handleInbound(id: number, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) {
      this.write({ jsonrpc: "2.0", id, error: { code: RpcError.METHOD_NOT_FOUND, message: "壳未注册请求处理器" } });
      return;
    }
    const controller = new AbortController();
    this.inbound.set(id, controller);
    try {
      const result = await this.requestHandler(method, params, {
        id,
        signal: controller.signal,
        throwIfCancelled: () => {
          if (controller.signal.aborted) throw cancelledError();
        },
      });
      this.write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (err) {
      const isCancel = err instanceof Error && err.name === "CancelledError";
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: isCancel ? RpcError.SHELL_ERROR : toRpcCode(err),
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      this.inbound.delete(id);
    }
  }

  // ───────────────────────── 底层 ─────────────────────────

  private request(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error("内核未运行"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时也顺手取消内核侧的工作
        this.notify("$/cancelRequest", { id });
        reject(new Error(`RPC 超时：${method}（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
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

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

function toRpcCode(err: unknown): number {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "PathPolicyError":
      return RpcError.SIG_DENIED;
    default:
      return RpcError.SHELL_ERROR;
  }
}
