import * as path from "node:path";
import * as vscode from "vscode";
import type { ModelConfigDto, Mode } from "./protocol";

/** 壳侧只读配置视图：设置项 + 路径占位符解析。 */
export interface ShellConfig {
  coreMode: "python" | "mock";
  pythonPath: string;
  coreArgs: string[];
  cwd: string;
  model: ModelConfigDto;
  apiKeyId: string;
  maxSteps: number;
  toolTimeoutMs: number;
  granularity: "function" | "change" | "file";
  checkpointEnabled: boolean;
  checkpointRetention: number;
}

export function readConfig(): ShellConfig {
  const cfg = vscode.workspace.getConfiguration("beeCode");
  const folders = vscode.workspace.workspaceFolders ?? [];
  const firstRoot = folders[0]?.uri.fsPath;

  const rawCwd = cfg.get<string>("core.cwd", "${workspaceFolder}");
  const cwd = resolvePlaceholders(rawCwd, firstRoot);

  return {
    coreMode: cfg.get<"python" | "mock">("core.mode", "python"),
    pythonPath: cfg.get<string>("core.pythonPath", "python"),
    coreArgs: cfg.get<string[]>("core.args", ["-m", "beecode"]),
    cwd,
    apiKeyId: cfg.get<string>("model.apiKeyId", "beeCode.apiKey.default"),
    model: {
      baseUrl: cfg.get<string>("model.baseUrl", ""),
      model: cfg.get<string>("model.model", ""),
      temperature: cfg.get<number>("model.temperature", 0.2),
      maxOutputTokens: cfg.get<number>("model.maxOutputTokens", 8192),
      supportsTools: cfg.get<boolean>("model.supportsTools", true),
    },
    maxSteps: cfg.get<number>("agent.maxSteps", 30),
    toolTimeoutMs: cfg.get<number>("agent.toolTimeoutMs", 30000),
    granularity: cfg.get<"function" | "change" | "file">("review.granularity", "function"),
    checkpointEnabled: cfg.get<boolean>("checkpoint.enabled", true),
    checkpointRetention: cfg.get<number>("checkpoint.retention", 50),
  };
}

/** 把 `${workspaceFolder}` / `${workspaceFolder:name}` / `${userHome}` 换成真实路径 */
export function resolvePlaceholders(raw: string, workspaceRoot?: string): string {
  return raw
    .replace(/\$\{workspaceFolder(?::[^}]*)?\}/g, workspaceRoot ?? process.cwd())
    .replace(/\$\{userHome\}/g, process.env["USERPROFILE"] ?? process.env["HOME"] ?? process.cwd())
    .replace(/\$\{env:([^}]+)\}/g, (_m, name: string) => process.env[name] ?? "");
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

export function isWorkspaceEmpty(): boolean {
  return workspaceRoots().length === 0;
}

/** 供 footer/日志用 */
export function describeConfig(cfg: ShellConfig): string {
  const model = cfg.model.model || "<未配置>";
  const base = cfg.model.baseUrl || "<未配置>";
  return `mode=${cfg.coreMode} python=${path.basename(cfg.pythonPath)} model=${model} base=${base}`;
}
