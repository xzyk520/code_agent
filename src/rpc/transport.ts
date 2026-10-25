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
  /** A complete line was received (already framed on \n with \r stripped) */
  onLine(line: string): void;
  /** The process exited (including a failed start) */
  onExit(code: number | null, reason: string): void;
  /** Process-level error (spawn failure etc.); does not imply the process has exited */
  onError(error: Error): void;
}

/**
 * Transport layer: only "spawn the process + frame lines + write to the pipe".
 *
 * Why it is separate from RPC semantics (request tracking, cancellation, error codes):
 *   - Bugs in this layer (partial lines, backpressure, exit cleanup) are protocol-independent and
 *     easier to test on their own
 *   - Swapping the transport later (socket / WebSocket / remote) touches only this file
 *
 * Three things that must be right:
 *   1. `data` events are not guaranteed to align with lines -> collect them with LineReader
 *   2. `stdin.write()` returning false means the buffer is full -> wait for `drain`, otherwise large
 *      messages pile up in memory
 *   3. Flush any leftover partial line before the process exits
 */
export class ChildTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private disposed = false;

  constructor(private readonly opts: ChildTransportOptions) {}

  get alive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.disposed;
  }

  /** Whether spawn has happened (does not check liveness) */
  get started(): boolean {
    return this.child !== undefined;
  }

  start(handlers: TransportHandlers): void {
    if (this.child) return;
    const { pythonPath, args, cwd, logger } = this.opts;
    logger.info(`Starting core: ${pythonPath} ${args.join(" ")} (cwd=${cwd})`);

    const child = spawn(pythonPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // PYTHONPATH (to locate the beecode package) + encoding related; secrets still travel in the stdin message, not via environment variables
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    const reader = new LineReader(handlers.onLine);
    child.stdout.on("data", (chunk: string) => reader.push(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => logger.coreStderr(chunk));

    child.on("error", (err) => {
      logger.error(`Failed to start core process: ${err.message}`);
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
      handlers.onExit(null, `Start failed: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      reader.flush();
      const reason = signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
      logger.warn(`Core process exited (${reason})`);
      this.child = undefined;
      handlers.onExit(code, reason);
    });
  }

  /**
   * Write one line of message.
   *
   * The returned Promise really waits (on `drain`) only when **backpressure** occurs -- normally it
   * resolves immediately, so no extra microtask cost per notification.
   */
  async write(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    const flushed = child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!flushed) {
      await once(child.stdin, "drain").catch(() => undefined);
    }
  }

  /** Close input gracefully: the kernel sees EOF and exits on its own */
  endInput(): void {
    try {
      this.child?.stdin.end();
    } catch {
      /* The pipe may already be broken */
    }
  }

  kill(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch {
      /* The process may have exited already */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.endInput();
    this.kill();
    this.child = undefined;
  }
}
