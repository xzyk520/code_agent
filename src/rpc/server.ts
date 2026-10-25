import type { InboundRequestContext, InboundRequestHandler } from "../coreApi";
import type { Logger } from "../log";
import { RpcError, type ShellMethod, type ShellMethodParams, type ShellMethodResults } from "../protocol";

/** Strongly typed handler: the method name determines params and return type, so adapters no longer need `as never` */
export type ShellHandler<K extends ShellMethod> = (
  params: ShellMethodParams[K],
  ctx: InboundRequestContext,
) => Promise<ShellMethodResults[K]>;

/**
 * Shell-side RPC server: routes the methods sent by the kernel to adapters.
 *
 * It does only three things: look up the table, log timing, and translate exceptions into JSON-RPC errors.
 * **No business logic** -- that lives in the adapters and the kernel.
 *
 * `register` is generic: a wrong method name or param type fails at **compile time** instead of
 * surfacing later at runtime as `METHOD_NOT_FOUND`.
 */
export class ShellServer {
  private readonly handlers = new Map<ShellMethod, ShellHandler<ShellMethod>>();

  constructor(private readonly logger: Logger) {}

  register<K extends ShellMethod>(method: K, handler: ShellHandler<K>): void {
    if (this.handlers.has(method)) {
      // Duplicate registration is a startup programming error: silently overwriting would make "the new handler never took effect" very hard to diagnose
      throw new Error(`重复注册 RPC 方法: ${method}`);
    }
    // A single covariant assertion: strong types outward, one uniform signature in the internal table
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
