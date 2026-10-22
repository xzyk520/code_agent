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

/** 输出上限：stdout / stderr 各 64KB（模型不需要更多，多了反而撑爆上下文） */
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000;
/** 命令长度上限：防止把整个脚本塞进来（真脚本应该写文件） */
const MAX_COMMAND_LENGTH = 4_000;

/** 这些环境变量会把密钥递给子进程，必须剔除 */
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export interface RunPolicy {
  /** 沙箱模式：off=直接跑；docker=容器内；auto=有 docker 就用 */
  sandbox: "off" | "docker" | "auto";
  dockerImage: string;
}

export interface RunAdapterDeps {
  logger: Logger;
  /** 每次调用时现取策略（配置可能刚改过） */
  policy: () => RunPolicy;
  /** 沙箱可用性探测（缓存由调用方负责） */
  dockerAvailable: () => boolean;
}

/**
 * 命令执行（L1 + 可选 L3 沙箱）。
 *
 * 安全措施（缺一不可）：
 *   1. cwd 必须落在工作区内
 *   2. 环境变量清洗（剔除 *KEY* / *TOKEN* / *SECRET* …）
 *   3. 超时 + **整棵进程树** kill（否则 npm 的子进程会活下来）
 *   4. 输出限幅（各 64KB）
 *   5. 非交互（stdin 立即关闭，防止 git 之类卡住等输入）
 *   6. 可选 docker 沙箱：无网络、只读根文件系统、限制内存/PID、丢弃全部 capability
 */
export function createRunAdapter(deps: RunAdapterDeps) {
  return {
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
      const useDocker = policy.sandbox === "docker" || (policy.sandbox === "auto" && deps.dockerAvailable());

      if (policy.sandbox === "docker" && !deps.dockerAvailable()) {
        throw new Error("沙箱模式为 docker，但当前环境找不到 docker（请安装/启动 docker，或把 beeCode.permissions.sandbox 改为 auto/off）");
      }

      const startedAt = Date.now();
      const result = useDocker
        ? await runInDocker(deps, policy.dockerImage, root, cwd, command, timeoutMs, ctx.signal)
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
        sandbox: useDocker ? "docker" : "none",
        killed: result.killed,
      };
    },
  };
}

// ───────────────────────── 执行器 ─────────────────────────

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
      // POSIX 上独立进程组，超时才能连同子进程一起杀
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
 * docker 沙箱：
 *   --network none        无网络（防外联/下载）
 *   --read-only           根文件系统只读，只有工作区与 /tmp 可写
 *   --cap-drop ALL        丢弃全部 capability
 *   --memory / --pids     限制资源，防 fork 炸弹
 *   no-new-privileges     禁止提权
 */
function runInDocker(
  deps: RunAdapterDeps,
  image: string,
  root: string,
  cwd: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResult> {
  const relative = path.relative(root, cwd).split(path.sep).join("/");
  if (relative.startsWith("..")) {
    // docker 只挂载工作区；工作区外的 cwd 无法被沙箱覆盖，不能假装隔离
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
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${root}:/workspace`,
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

// ───────────────────────── 工具 ─────────────────────────

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
      // Windows 没有进程组信号，必须用 taskkill /T 杀整棵树
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => undefined);
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (err) {
    logger.warn(`终止进程失败: ${err instanceof Error ? err.message : String(err)}`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经退出 */
    }
  }
}

function stopContainer(name: string): void {
  const attempt = (remaining: number): void => {
    void execFileAsync("docker", ["rm", "-f", name]).catch(() => {
      // 容器可能还没创建完：短重试，避免 abort 后容器才开始跑
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
  // 保留最基本的可执行环境
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

/** docker 可用性探测（结果缓存由调用方负责） */
export async function detectDocker(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
