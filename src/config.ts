import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ModelConfigDto, Mode } from "./protocol";

/**
 * 壳侧配置收敛层。
 *
 * 设计要点：
 *   1. **快照制**：`readConfig()` 返回普通对象，设置变了不会自动更新 —— 调用方负责重读。
 *   2. **拿不到密钥**：这里只有 `apiKeyId`（SecretStorage 的键名），密钥本身由 extension 取。
 *   3. **运行时校验**：用户在 settings.json 里手写错了类型，就回退默认值并记录问题，
 *      而不是让 `step > "30"` 这类比较静默出错。
 */
/**
 * 密钥环境变量回退名。
 *
 * 用途：不想把 key 存在 VS Code 凭据库时（或 CI 里），可以设环境变量；
 * 优先级低于 SecretStorage（显式配置 > 环境默认）。
 */
export const API_KEY_ENV = "BEE_CODE_API_KEY";

export interface ShellConfig {
  coreMode: "python" | "mock";
  pythonPath: string;
  /** 含 beecode/ 包的目录；空串 = 自动探测（工作区 → 扩展目录） */
  coreRoot: string;
  /** 解释器参数；空数组 = 默认 `["-m","beecode"]` */
  coreArgs: string[];
  /** 子进程工作目录（已解析占位符）；无工作区时为空串，由 coreLocator 决定回退 */
  cwd: string;
  model: ModelConfigDto;
  apiKeyId: string;
  maxSteps: number;
  toolTimeoutMs: number;
  granularity: "function" | "change" | "file";
  checkpointEnabled: boolean;
  checkpointRetention: number;
  permissions: PermissionsConfig;
}

/** 权限相关配置（规则原文由 permissions.ts 解析） */
export interface PermissionsConfig {
  mode: "plan" | "manual" | "acceptEdits" | "auto" | "bypass";
  allow: string[];
  ask: string[];
  deny: string[];
  sandbox: "off" | "docker" | "auto";
  dockerImage: string;
  requireTrust: boolean;
  /** 开放完整权限：免掉审批（但不解除"未信任"和"工作区外"的限制） */
  fullAccess: boolean;
}

export interface ConfigReadResult {
  config: ShellConfig;
  /** 校验发现的问题（已回退默认值）。启动时写日志并提示用户，不阻塞运行。 */
  problems: string[];
}

export function readConfig(): ConfigReadResult {
  const reader = new Reader(vscode.workspace.getConfiguration("beeCode"));
  const folders = vscode.workspace.workspaceFolders ?? [];
  const firstRoot = folders[0]?.uri.fsPath;

  const config: ShellConfig = {
    coreMode: reader.oneOf("core.mode", "python", ["python", "mock"] as const),
    pythonPath: reader.str("core.pythonPath", "python"),
    coreRoot: resolvePlaceholders(reader.str("core.coreRoot", ""), firstRoot),
    coreArgs: reader.strArray("core.args", []),
    cwd: resolvePlaceholders(reader.str("core.cwd", "${workspaceFolder}"), firstRoot),
    apiKeyId: reader.str("model.apiKeyId", "beeCode.apiKey.default"),
    model: {
      baseUrl: reader.str("model.baseUrl", ""),
      model: reader.str("model.model", ""),
      temperature: reader.num("model.temperature", 0.2, 0, 2),
      maxOutputTokens: reader.num("model.maxOutputTokens", 8192, 1, 1_000_000),
      supportsTools: reader.bool("model.supportsTools", true),
      supportsVision: reader.oneOf("model.supportsVision", "auto", ["auto", "on", "off"] as const),
    },
    maxSteps: reader.num("agent.maxSteps", 30, 1, 500),
    toolTimeoutMs: reader.num("agent.toolTimeoutMs", 30_000, 1_000, 600_000),
    granularity: reader.oneOf("review.granularity", "function", ["function", "change", "file"] as const),
    checkpointEnabled: reader.bool("checkpoint.enabled", true),
    checkpointRetention: reader.num("checkpoint.retention", 50, 1, 1_000),
    permissions: {
      mode: reader.oneOf("permissions.mode", "manual", ["plan", "manual", "acceptEdits", "auto", "bypass"] as const),
      allow: reader.strArray("permissions.allow", []),
      ask: reader.strArray("permissions.ask", []),
      deny: reader.strArray("permissions.deny", []),
      sandbox: reader.oneOf("permissions.sandbox", "off", ["off", "docker", "auto"] as const),
      dockerImage: reader.str("permissions.dockerImage", "node:22-alpine"),
      requireTrust: reader.bool("permissions.requireTrust", true),
      fullAccess: reader.bool("permissions.fullAccess", false),
    },
  };

  return { config, problems: reader.problems };
}

/**
 * 带类型校验的读取器：每次 `get` 都验证真实类型与取值范围。
 *
 * 为什么不能只写 `cfg.get<number>(...)`：泛型只是在**编译期**声称类型，
 * 运行时完全可能是 `"30"`（用户在 settings.json 里手写字符串）。
 */
class Reader {
  readonly problems: string[] = [];

  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  str(key: string, fallback: string): string {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "string") return this.bad(key, "字符串", raw, fallback);
    return raw;
  }

  num(key: string, fallback: number, min: number, max: number): number {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return this.bad(key, "数字", raw, fallback);
    if (raw < min || raw > max) {
      this.problems.push(`beeCode.${key} 超出范围 [${min}, ${max}]（实际 ${raw}），已使用默认值 ${fallback}`);
      return fallback;
    }
    return raw;
  }

  bool(key: string, fallback: boolean): boolean {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "boolean") return this.bad(key, "布尔值", raw, fallback);
    return raw;
  }

  oneOf<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "string" || !allowed.includes(raw as T)) {
      const expected = allowed.map((a) => `"${a}"`).join(" / ");
      this.problems.push(
        `beeCode.${key} 只能是 ${expected}，实际是 ${safeJson(raw)}，已使用默认值 "${fallback}"`,
      );
      return fallback;
    }
    return raw as T;
  }

  strArray(key: string, fallback: string[]): string[] {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return [...fallback];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      return this.bad(key, "字符串数组", raw, fallback);
    }
    return [...(raw as string[])];
  }

  private bad<T>(key: string, expect: string, raw: unknown, fallback: T): T {
    this.problems.push(
      `beeCode.${key} 应为${expect}，实际是 ${typeOf(raw)}（${safeJson(raw)}），已使用默认值 ${safeJson(fallback)}`,
    );
    return fallback;
  }
}

/**
 * 把 `${workspaceFolder}` / `${workspaceFolder:name}` / `${userHome}` / `${env:X}` 换成真实路径。
 *
 * ⚠️ `getConfiguration().get()` **不会**替你展开这些占位符 —— 拿到的就是原始字符串。
 * 没有工作区时 `${workspaceFolder}` 展开成空串（而不是 `process.cwd()`：
 * 扩展宿主进程的 cwd 通常是 VS Code 安装目录，几乎肯定不是用户想要的）。
 */
export function resolvePlaceholders(raw: string, workspaceRoot?: string): string {
  if (!raw) return "";
  return raw
    .replace(/\$\{workspaceFolder(?::[^}]*)?\}/g, workspaceRoot ?? "")
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "")
    .trim();
}

/** 每个会话一个 id；壳不解释它，只做路由 */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultInstruction(mode: Mode): string {
  switch (mode) {
    case "builder":
      return "请按选中代码生成改动。";
    case "debugger":
      return "请排查这段代码的问题。";
    case "chat":
    default:
      return "请解释这段代码。";
  }
}

/** 工作区根（多根时取第一个；内核也会收到全部根） */
export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** 没有打开任何文件夹时，扩展的绝大多数能力都无从谈起（读文件、检查点、diff） */
export function isWorkspaceEmpty(): boolean {
  return workspaceRoots().length === 0;
}

/** 供 footer/日志用（不含任何密钥；baseUrl 由 Logger 统一脱敏） */
export function describeConfig(cfg: ShellConfig): string {
  const model = cfg.model.model || "<未配置>";
  const base = cfg.model.baseUrl || "<未配置>";
  const cwd = cfg.cwd || "<无工作区>";
  return `mode=${cfg.coreMode} python=${path.basename(cfg.pythonPath)} model=${model} base=${base} cwd=${cwd}`;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
