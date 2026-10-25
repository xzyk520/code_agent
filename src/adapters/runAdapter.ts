import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { isInside } from "../paths";
import type { RunParams, RunResult } from "../protocol";

const execFileAsync = promisify(execFile);

/** Output cap: 64KB each for stdout / stderr (the model needs no more; extra would only blow up the context) */
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000;
/** Command length cap: stops an entire script being pasted in here (a real script belongs in a file) */
const MAX_COMMAND_LENGTH = 4_000;

/** These environment variables hand secrets to the child process and must be stripped */
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export interface RunPolicy {
  /** Sandbox mode: off = run directly; docker = inside a container; auto = use docker when available */
  sandbox: "off" | "docker" | "auto";
  dockerImage: string;
}

export interface RunAdapterDeps {
  logger: Logger;
  /** Policy is fetched fresh on every call (the config may have just changed) */
  policy: () => RunPolicy;
  /** Sandbox availability probe (caching is the caller's responsibility) */
  dockerAvailable: () => boolean;
}

/**
 * Command execution (L1 + optional L3 sandbox).
 *
 * Safety measures (none optional):
 *   1. cwd must lie inside the workspace
 *   2. Environment scrubbing (strip *KEY* / *TOKEN* / *SECRET* …)
 *   3. Timeout + killing the **whole process tree** (otherwise npm's child processes survive)
 *   4. Output clamping (64KB each)
 *   5. Non-interactive (stdin closed immediately, so tools like git don't hang waiting for input)
 *   6. Optional docker sandbox: no network, read-only root filesystem, memory/PID limits, all capabilities dropped
 */
export function createRunAdapter(deps: RunAdapterDeps) {
  return {
    /** Start a background command with no hard timeout; the shell side manages it via wait/kill */
    async start(params: RunParams, ctx: InboundRequestContext): Promise<CommandJob> {
      return startJob(deps, params, ctx);
    },

    async run(params: RunParams, ctx: InboundRequestContext): Promise<RunResult> {
      ctx.throwIfCancelled();
      const command = (params.command ?? "").trim();
      if (!command) throw new Error("command 不能为空");
      if (command.length > MAX_COMMAND_LENGTH) {
        throw new Error(`命令过长（${command.length} > ${MAX_COMMAND_LENGTH} 字符）：请写成脚本文件再执行`);
      }

      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error("未打开工作区：命令必须在工作区内执行");

      const cwd = resolveCwd(root, params.cwd);
      const timeoutMs = clamp(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
      const policy = deps.policy();
      const requested = params.sandbox ?? "auto";
      if ((requested === "sandbox-readonly" || requested === "sandbox" || requested === "sandbox-network") && !deps.dockerAvailable()) {
        throw new Error("请求在 Docker 沙箱内执行，但当前环境找不到 docker；如确需真实环境执行，请用 sandbox=host 并说明理由。");
      }
      const useDocker =
        requested === "host"
          ? false
          : requested === "sandbox-readonly" || requested === "sandbox" || requested === "sandbox-network"
            ? true
            : policy.sandbox === "docker" || (policy.sandbox === "auto" && deps.dockerAvailable());

      if (policy.sandbox === "docker" && !deps.dockerAvailable() && requested !== "host") {
        throw new Error("沙箱模式为 docker，但当前环境找不到 docker（请安装/启动 docker，或把 beeCode.permissions.sandbox 改为 auto/off）");
      }

      const startedAt = Date.now();
      const result = useDocker
        ? await runInDocker(
            deps,
            policy.dockerImage,
            root,
            cwd,
            command,
            timeoutMs,
            ctx.signal,
            requested !== "sandbox-readonly",
            requested === "sandbox-network",
          )
        : await runDirect(deps, cwd, command, timeoutMs, ctx.signal);

      const durationMs = Date.now() - startedAt;
      deps.logger.info(
        `run（${useDocker ? "docker" : "direct"}）exit=${result.exitCode} ${durationMs}ms: ${command.slice(0, 120)}`,
      );

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        durationMs,
        sandbox:
          requested === "host"
            ? "host"
            : requested === "sandbox-network"
              ? "docker-network"
              : requested === "sandbox-readonly"
                ? "docker-readonly"
                : useDocker
                  ? "docker"
                  : "none",
        killed: result.killed,
      };
    },
  };
}

// ───────────────────────── Executors ─────────────────────────

interface RawResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  killed: boolean;
}

function runDirect(
  deps: RunAdapterDeps,
  cwd: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResult> {
  if (signal?.aborted) {
    return Promise.resolve({ exitCode: 130, stdout: "", stderr: "已取消", truncated: false, killed: true });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      // Own process group on POSIX, so a timeout can kill the children along with the parent
      detached: process.platform !== "win32",
      env: sanitizedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const state = { stdout: "", stderr: "", truncated: false, killed: false };
    child.stdout?.on("data", (chunk: Buffer) => appendCapped(state, "stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendCapped(state, "stderr", chunk));

    const kill = () => {
      if (state.killed) return;
      state.killed = true;
      killTree(child, deps.logger);
    };
    const timer = setTimeout(kill, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) kill();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanup();
      reject(new Error(`启动命令失败：${err.message}`));
    });

    child.on("close", (code) => {
      cleanup();
      resolve({
        exitCode: code ?? (state.killed ? 124 : -1),
        stdout: state.stdout,
        stderr: state.stderr,
        truncated: state.truncated,
        killed: state.killed,
      });
    });
  });
}

/**
 * docker sandbox:
 *   --network none        base sandbox: no network (no outbound calls/downloads)
 *   --network bridge      sandbox-network: outbound network allowed, all other limits unchanged
 *   --read-only           read-only root filesystem; only the workspace and /tmp are writable
 *   --cap-drop ALL        drop every capability
 *   --memory / --pids     resource limits, guarding against fork bombs
 *   no-new-privileges     forbid privilege escalation
 */
function runInDocker(
  deps: RunAdapterDeps,
  image: string,
  root: string,
  cwd: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  workspaceWritable = true,
  network = false,
): Promise<RawResult> {
  const relative = path.relative(root, cwd).split(path.sep).join("/");
  if (relative.startsWith("..")) {
    // docker only mounts the workspace; a cwd outside it cannot be covered by the sandbox, so don't pretend it is isolated
    throw new Error("工作区外的目录无法在 docker 沙箱中执行：请在工作区内运行，或改用 off 模式（需自行承担风险）");
  }
  const workdir = relative ? `/workspace/${relative}` : "/workspace";
  const container = `bee-code-${randomUUID().slice(0, 8)}`;
  const args = [
    "run",
    "--rm",
    "--name",
    container,
    "-i",
    "--network",
    network ? "bridge" : "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${root}:/workspace${workspaceWritable ? "" : ":ro"}`,
    "-w",
    workdir,
    "--memory",
    "2g",
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    image,
    "sh",
    "-lc",
    command,
  ];
  return runProcess("docker", args, root, timeoutMs, deps.logger, signal, container);
}

function runProcess(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  logger: Logger,
  signal?: AbortSignal,
  containerName?: string,
): Promise<RawResult> {
  if (signal?.aborted) {
    return Promise.resolve({ exitCode: 130, stdout: "", stderr: "已取消", truncated: false, killed: true });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state = { stdout: "", stderr: "", truncated: false, killed: false };
    child.stdout?.on("data", (chunk: Buffer) => appendCapped(state, "stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendCapped(state, "stderr", chunk));

    const kill = () => {
      if (state.killed) return;
      state.killed = true;
      killTree(child, logger);
      if (containerName) stopContainer(containerName);
    };
    const timer = setTimeout(kill, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) kill();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanup();
      reject(new Error(`启动 ${file} 失败：${err.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        exitCode: code ?? (state.killed ? 124 : -1),
        stdout: state.stdout,
        stderr: state.stderr,
        truncated: state.truncated,
        killed: state.killed,
      });
    });
  });
}

// ───────────────────────── Utilities ─────────────────────────

// ───────────────────────── Long-running command jobs ─────────────────────────

export interface CommandJobSnapshot {
  id: string;
  finished: boolean;
  exitCode: number | null;
  killed: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  outputAgeMs?: number;
}

export interface CommandJob {
  id: string;
  sandbox: RunResult["sandbox"];
  startedAt: number;
  wait(ms: number): Promise<CommandJobSnapshot>;
  kill(): void;
  /** Notify once when the child process exits (used to record a checkpoint after the command finishes) */
  onFinished(callback: () => void): void;
  /** Inspect the current state without consuming the cursor; used by command_list */
  peek(): CommandJobSnapshot;
  /** Consume output since the last readNew; old content is never returned again */
  readNew(): CommandJobSnapshot;
  tail(maxChars?: number): string;
}

interface JobSpec {
  file: string;
  args: string[];
  cwd: string;
  shell: boolean;
  containerName?: string;
  sandbox: RunResult["sandbox"];
}

async function startJob(deps: RunAdapterDeps, params: RunParams, ctx: InboundRequestContext): Promise<CommandJob> {
  ctx.throwIfCancelled();
  const command = (params.command ?? "").trim();
  if (!command) throw new Error("command 不能为空");
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`命令过长（${command.length} > ${MAX_COMMAND_LENGTH} 字符）：请写成脚本文件再执行`);
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error("未打开工作区：命令必须在工作区内执行");
  const cwd = resolveCwd(root, params.cwd);
  const policy = deps.policy();
  const requested = params.sandbox ?? "auto";
  const useDocker =
    requested === "host"
      ? false
      : requested === "sandbox-readonly" || requested === "sandbox" || requested === "sandbox-network"
        ? true
        : policy.sandbox === "docker" || (policy.sandbox === "auto" && deps.dockerAvailable());
  if (
    (requested === "sandbox-readonly" || requested === "sandbox" || requested === "sandbox-network") &&
    !deps.dockerAvailable()
  ) {
    throw new Error("请求在 Docker 沙箱内执行，但当前环境找不到 docker；如确需真实环境执行，请用 sandbox=host 并说明理由。");
  }
  if (policy.sandbox === "docker" && !deps.dockerAvailable() && requested !== "host") {
    throw new Error("沙箱模式为 docker，但当前环境找不到 docker（请安装/启动 docker，或把 beeCode.permissions.sandbox 改为 auto/off）");
  }

  let spec: JobSpec;
  if (useDocker) {
    const relative = path.relative(root, cwd).split(path.sep).join("/");
    if (relative.startsWith("..")) {
      throw new Error("工作区外的目录无法在 docker 沙箱中执行：请在工作区内运行，或改用 off 模式（需自行承担风险）");
    }
    const workdir = relative ? `/workspace/${relative}` : "/workspace";
    const container = `bee-code-${randomUUID().slice(0, 8)}`;
    const args = [
      "run", "--rm", "--name", container, "-i",
      "--network", requested === "sandbox-network" ? "bridge" : "none",
      "--read-only", "--tmpfs", "/tmp",
      "-v", `${root}:/workspace${requested === "sandbox-readonly" ? ":ro" : ""}`,
      "-w", workdir, "--memory", "2g", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      policy.dockerImage, "sh", "-lc", command,
    ];
    spec = {
      file: "docker",
      args,
      cwd: root,
      shell: false,
      containerName: container,
      sandbox:
        requested === "sandbox-network" ? "docker-network" : requested === "sandbox-readonly" ? "docker-readonly" : "docker",
    };
  } else {
    spec = {
      file: command,
      args: [],
      cwd,
      shell: true,
      sandbox: requested === "host" ? "host" : "none",
    };
  }
  return createJob(deps, spec, command, ctx.signal);
}

function createJob(
  deps: RunAdapterDeps,
  spec: JobSpec,
  command: string,
  signal?: AbortSignal,
): CommandJob {
  const id = randomUUID();
  const startedAt = Date.now();
  const state = { stdout: "", stderr: "", truncated: false, killed: false, exitCode: null as number | null, finished: false, lastOutputAt: 0 as number };
  let cursorOut = 0;
  let cursorErr = 0;
  const waiters = new Set<() => void>();
  const finishCallbacks: Array<() => void> = [];
  let finishNotified = false;

  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const child = spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    shell: spec.shell,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: spec.shell ? sanitizedEnv() : undefined,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    appendCapped(state, "stdout", chunk);
    state.lastOutputAt = Date.now();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    appendCapped(state, "stderr", chunk);
    state.lastOutputAt = Date.now();
  });
  child.on("error", (err) => {
    state.finished = true;
    state.exitCode = -1;
    if (!state.stderr) state.stderr = `启动命令失败：${err.message}`;
    signal?.removeEventListener("abort", onAbort);
    notify();
    if (!finishNotified) {
      finishNotified = true;
      for (const callback of finishCallbacks) callback();
    }
  });
  child.on("close", (code) => {
    state.finished = true;
    state.exitCode = code ?? (state.killed ? 124 : -1);
    signal?.removeEventListener("abort", onAbort);
    notify();
    if (!finishNotified) {
      finishNotified = true;
      for (const callback of finishCallbacks) callback();
    }
  });

  const kill = () => {
    if (state.killed || state.finished) return;
    state.killed = true;
    killTree(child, deps.logger);
    if (spec.containerName) stopContainer(spec.containerName);
  };
  const onAbort = () => kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) kill();

  const snapshot = (): CommandJobSnapshot => ({
    id,
    finished: state.finished,
    exitCode: state.finished ? state.exitCode : null,
    killed: state.killed,
    truncated: state.truncated,
    stdout: state.stdout,
    stderr: state.stderr,
    elapsedMs: Date.now() - startedAt,
    ...(state.lastOutputAt > 0 ? { outputAgeMs: Date.now() - state.lastOutputAt } : {}),
  });

  const wait = (ms: number): Promise<CommandJobSnapshot> => {
    if (state.finished) {
      signal?.removeEventListener("abort", onAbort);
      return Promise.resolve(snapshot());
    }
    return new Promise((resolve) => {
      if (state.finished) {
        resolve(snapshot());
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(snapshot());
      };
      const timer = setTimeout(finish, Math.max(0, Math.min(ms, 300_000)));
      timer.unref?.();
      waiters.add(finish);
    }).finally(() => {
      if (state.finished) signal?.removeEventListener("abort", onAbort);
    }) as Promise<CommandJobSnapshot>;
  };

  const readNew = (): CommandJobSnapshot => {
    const snap = snapshot();
    const out = snap.stdout.slice(cursorOut);
    const err = snap.stderr.slice(cursorErr);
    cursorOut = snap.stdout.length;
    cursorErr = snap.stderr.length;
    return { ...snap, stdout: out, stderr: err };
  };

  const tail = (maxChars = 4_000): string => {
    const text = `${state.stdout}\n${state.stderr}`.trim();
    return text.length <= maxChars ? text : text.slice(-maxChars);
  };

  const onFinished = (callback: () => void): void => {
    if (finishNotified) callback();
    else finishCallbacks.push(callback);
  };

  deps.logger.info(`job ${id.slice(0, 8)} started: ${command.slice(0, 120)}`);
  return { id, sandbox: spec.sandbox, startedAt, wait, kill, onFinished, readNew, peek: snapshot, tail };
}

function appendCapped(state: { stdout: string; stderr: string; truncated: boolean }, stream: "stdout" | "stderr", chunk: Buffer): void {
  const current = Buffer.byteLength(state[stream], "utf8");
  if (current >= MAX_OUTPUT_BYTES) {
    state.truncated = true;
    return;
  }
  const room = MAX_OUTPUT_BYTES - current;
  const text = chunk.subarray(0, room).toString("utf8");
  state[stream] += text;
  if (chunk.length > room) state.truncated = true;
}

function killTree(child: ReturnType<typeof spawn>, logger: Logger): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // Windows has no process-group signals, so taskkill /T is required to kill the whole tree
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => undefined);
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (err) {
    logger.warn(`终止进程失败: ${err instanceof Error ? err.message : String(err)}`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

function stopContainer(name: string): void {
  const attempt = (remaining: number): void => {
    void execFileAsync("docker", ["rm", "-f", name]).catch(() => {
      // The container may not be created yet: retry briefly, so it doesn't start running only after the abort
      if (remaining > 0) setTimeout(() => attempt(remaining - 1), 150);
    });
  };
  attempt(3);
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  // Keep the bare minimum executable environment
  env.PATH = process.env.PATH ?? "";
  return env;
}

function resolveCwd(root: string, requested: string | undefined): string {
  const candidate = requested && requested.trim().length > 0 ? path.resolve(root, requested) : root;
  if (!isInside(root, candidate)) {
    throw new Error(`cwd 越界：${requested}（必须位于工作区内）`);
  }
  return candidate;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Docker availability probe (caching the result is the caller's responsibility) */
export async function detectDocker(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
