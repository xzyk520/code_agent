import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { Logger } from "../log";
import { LineReader, type JsonRpcMessage } from "../protocol";

export interface ChildTransportOptions {
  pythonPath: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  logger: Logger;
}

export interface TransportHandlers {
  /** 收到一整行（已按 \n 分帧、去掉 \r） */
  onLine(line: string): void;
  /** 进程退出（含启动失败） */
  onExit(code: number | null, reason: string): void;
  /** 进程级错误（spawn 失败等）；不代表已退出 */
  onError(error: Error): void;
}

/**
 * 传输层：只管「起进程 + 分帧 + 写管道」。
 *
 * 与 RPC 语义（请求跟踪、取消、错误码）分开的原因：
 *   - 这一层的 bug（残行、背压、退出清理）和协议无关，单独测更清楚
 *   - 将来换传输（socket / WebSocket / 远端）只改这个文件
 *
 * 三个必须做对的点：
 *   1. `data` 事件不保证整数行 → 用 LineReader 攒行
 *   2. `stdin.write()` 返回 false 表示缓冲满 → 等 `drain`，否则大报文堆内存
 *   3. 进程退出前把残行 flush 出来
 */
export class ChildTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private disposed = false;

  constructor(private readonly opts: ChildTransportOptions) {}

  get alive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.disposed;
  }

  /** 是否已经 spawn 过（不判断存活） */
  get started(): boolean {
    return this.child !== undefined;
  }

  start(handlers: TransportHandlers): void {
    if (this.child) return;
    const { pythonPath, args, cwd, logger } = this.opts;
    logger.info(`启动内核: ${pythonPath} ${args.join(" ")} (cwd=${cwd})`);

    const child = spawn(pythonPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // PYTHONPATH（定位 beecode 包）+ 编码相关；密钥仍走 stdin 报文，不进环境变量
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    const reader = new LineReader(handlers.onLine);
    child.stdout.on("data", (chunk: string) => reader.push(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => logger.coreStderr(chunk));

    child.on("error", (err) => {
      logger.error(`内核进程启动失败: ${err.message}`);
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
      handlers.onExit(null, `启动失败：${err.message}`);
    });

    child.on("exit", (code, signal) => {
      reader.flush();
      const reason = signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
      logger.warn(`内核进程退出（${reason}）`);
      this.child = undefined;
      handlers.onExit(code, reason);
    });
  }

  /**
   * 写一行报文。
   *
   * 返回 Promise 只在**发生背压**时才真正等待（`drain`）——正常情况立即 resolve，
   * 不会给每个通知增加一个微任务开销。
   */
  async write(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    const flushed = child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!flushed) {
      await once(child.stdin, "drain").catch(() => undefined);
    }
  }

  /** 优雅关闭输入：内核读到 EOF 会自己退 */
  endInput(): void {
    try {
      this.child?.stdin.end();
    } catch {
      /* 管道可能已断 */
    }
  }

  kill(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch {
      /* 进程可能已退出 */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.endInput();
    this.kill();
    this.child = undefined;
  }
}
