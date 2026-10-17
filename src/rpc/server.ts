import type { InboundRequestContext, InboundRequestHandler } from "../coreApi";
import type { Logger } from "../log";
import { RpcError } from "../protocol";

export type ShellHandler = (params: unknown, ctx: InboundRequestContext) => Promise<unknown>;

/**
 * 壳侧 RPC 服务端：把内核发来的 method 路由到适配器。
 *
 * 只做三件事：查表、记录耗时、把异常翻译成 JSON-RPC 错误。
 * **不放业务逻辑** —— 业务在适配器和内核里。
 */
export class ShellServer {
  private readonly handlers = new Map<string, ShellHandler>();

  constructor(private readonly logger: Logger) {}

  register(method: string, handler: ShellHandler): void {
    if (this.handlers.has(method)) {
      this.logger.warn(`重复注册 RPC 方法: ${method}`);
    }
    this.handlers.set(method, handler);
  }

  readonly handle: InboundRequestHandler = async (
    method: string,
    params: unknown,
    ctx: InboundRequestContext,
  ): Promise<unknown> => {
    const handler = this.handlers.get(method);
    if (!handler) {
      const err = new Error(`未知 RPC 方法: ${method}`);
      err.name = "MethodNotFound";
      throw err;
    }

    const startedAt = Date.now();
    try {
      const result = await handler(params, ctx);
      const elapsed = Date.now() - startedAt;
      if (elapsed > 2_000) {
        this.logger.debug(`${method} 耗时 ${elapsed}ms`);
      }
      return result;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      this.logger.warn(`${method} 失败（${elapsed}ms）: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };

  listed(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

/** 把适配器异常映射成协议错误码；未知异常用 SHELL_ERROR */
export function rpcCodeFor(err: unknown): number {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "PathPolicyError":
      return RpcError.SIG_DENIED;
    case "MethodNotFound":
      return RpcError.METHOD_NOT_FOUND;
    case "CancelledError":
      return RpcError.SHELL_ERROR;
    default:
      return RpcError.SHELL_ERROR;
  }
}
