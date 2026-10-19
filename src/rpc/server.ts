import type { InboundRequestContext, InboundRequestHandler } from "../coreApi";
import type { Logger } from "../log";
import { RpcError, type ShellMethod, type ShellMethodParams, type ShellMethodResults } from "../protocol";

/** 强类型处理器：方法名决定参数与返回类型，适配器不再需要 `as never` */
export type ShellHandler<K extends ShellMethod> = (
  params: ShellMethodParams[K],
  ctx: InboundRequestContext,
) => Promise<ShellMethodResults[K]>;

/**
 * 壳侧 RPC 服务端：把内核发来的 method 路由到适配器。
 *
 * 只做三件事：查表、记录耗时、把异常翻译成 JSON-RPC 错误。
 * **不放业务逻辑** —— 业务在适配器和内核里。
 *
 * `register` 是泛型的：写错方法名或参数类型会在**编译期**报错，
 * 而不是等到运行时 `METHOD_NOT_FOUND`。
 */
export class ShellServer {
  private readonly handlers = new Map<ShellMethod, ShellHandler<ShellMethod>>();

  constructor(private readonly logger: Logger) {}

  register<K extends ShellMethod>(method: K, handler: ShellHandler<K>): void {
    if (this.handlers.has(method)) {
      // 重复注册是启动期的编程错误：静默覆盖会让"新 handler 没生效"极难排查
      throw new Error(`重复注册 RPC 方法: ${method}`);
    }
    // 单次协变断言：对外保持强类型，对内用统一签名存表
    this.handlers.set(method, handler as unknown as ShellHandler<ShellMethod>);
  }

  readonly handle: InboundRequestHandler = async (
    method: string,
    params: unknown,
    ctx: InboundRequestContext,
  ): Promise<unknown> => {
    const handler = this.handlers.get(method as ShellMethod);
    if (!handler) {
      const err = new Error(`未知 RPC 方法: ${method}`);
      err.name = "MethodNotFound";
      throw err;
    }

    const startedAt = Date.now();
    try {
      const result = await handler(params as never, ctx);
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

  listed(): ShellMethod[] {
    return [...this.handlers.keys()].sort();
  }
}
