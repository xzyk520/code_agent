import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ModelConfigDto, Mode } from "./protocol";
import { normalizeLocale, type Locale } from "./i18n";

/**
 * Shell-side configuration convergence layer.
 *
 * Design notes:
 *   1. **Snapshot semantics**: `readConfig()` returns a plain object, so settings changes are not
 *      reflected automatically -- the caller is responsible for re-reading.
 *   2. **No access to the secret**: only `apiKeyId` (the SecretStorage key name) lives here; the
 *      secret itself is fetched by the extension.
 *   3. **Runtime validation**: if the user writes the wrong type in settings.json we fall back to the
 *      default and record the problem, rather than letting comparisons such as `step > "30"` fail
 *      silently.
 */
/**
 * Environment variable fallback name for the API key.
 *
 * Purpose: when you do not want to store the key in the VS Code credential store (or in CI) you can
 * set an environment variable instead; its priority is below SecretStorage (explicit config >
 * environment default).
 */
export const API_KEY_ENV = "BEE_CODE_API_KEY";
/** Environment variable fallback name for the subagent key */
export const SUBAGENT_API_KEY_ENV = "BEE_CODE_SUBAGENT_API_KEY";
export const SUMMARY_API_KEY_ENV = "BEE_CODE_SUMMARY_API_KEY";

export interface ShellConfig {
  /** Language for user-visible UI / logs; model prompts and tool descriptions stay English */
  language: Locale;
  /** Base font size for the chat panel in CSS pixels */
  fontSize: number;
  coreMode: "python" | "mock";
  pythonPath: string;
  /** Directory containing the beecode/ package; empty string = auto-detect (workspace -> extension dir) */
  coreRoot: string;
  /** Interpreter arguments; empty array = default `["-m","beecode"]` */
  coreArgs: string[];
  /** Child process working directory (placeholders already resolved); empty string when there is no workspace, in which case coreLocator picks the fallback */
  cwd: string;
  model: ModelConfigDto;
  apiKeyId: string;
  maxSteps: number;
  toolTimeoutMs: number;
  longToolTimeoutMs: number;
  largeTaskSteps: number;
  maxTurnTokens: number;
  maxTurnSeconds: number;
  largeTaskSeconds: number;
  firstTokenSeconds: number;
  idleSeconds: number;
  maxToolCallsPerBatch: number;
  granularity: "function" | "change" | "file";
  checkpointEnabled: boolean;
  checkpointRetention: number;
  permissions: PermissionsConfig;
  subagent: SubagentConfig;
  summary: SummaryConfig;
  /** Initial panel mode (auto = decide automatically) */
  focus: FocusConfig;
  attachments: AttachmentsConfig;
}

/** Limits on the number and size of attachments (code selections / files) */
export interface AttachmentsConfig {
  maxCount: number;
  maxTotalChars: number;
  maxCharsPerItem: number;
}

/** Strategy for reading code near the cursor */
export interface FocusConfig {
  /** Automatically attach the function/code block under the cursor when sending */
  autoAttach: boolean;
  /** How many lines to take above and below when not inside a function */
  fallbackLines: number;
  /** Degrade to a code block once a function exceeds this many lines */
  maxLines: number;
  /** Whether to highlight "which section the agent read" in the editor */
  highlight: boolean;
}

/** Subagent config: empty string = inherit from the main agent */
export interface SubagentConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyId: string;
  maxSteps: number;
  supportsVision: "auto" | "on" | "off";
}

/** Summary model: empty model = reuse the main agent's model */
export interface SummaryConfig {
  baseUrl: string;
  model: string;
  apiKeyId: string;
}

/** Permission-related config (raw rule text is parsed by permissions.ts) */
export interface PermissionsConfig {
  mode: "plan" | "manual" | "acceptEdits" | "auto" | "bypass";
  allow: string[];
  ask: string[];
  deny: string[];
  sandbox: "off" | "docker" | "auto";
  dockerImage: string;
  requireTrust: boolean;
  /** Grant full permissions: skip approvals (but the "untrusted" and "outside workspace" restrictions remain) */
  fullAccess: boolean;
}

export interface ConfigReadResult {
  config: ShellConfig;
  /** Problems found during validation (defaults were used instead). Logged and surfaced to the user at startup; does not block execution. */
  problems: string[];
}

export function readConfig(): ConfigReadResult {
  const reader = new Reader(vscode.workspace.getConfiguration("beeCode"));
  const folders = vscode.workspace.workspaceFolders ?? [];
  const firstRoot = folders[0]?.uri.fsPath;

  const config: ShellConfig = {
    language: normalizeLocale(reader.str("ui.language", "en")),
    fontSize: reader.num("ui.fontSize", 14, 10, 24),
    coreMode: reader.oneOf("core.mode", "python", ["python", "mock"] as const),
    pythonPath: reader.str("core.pythonPath", "auto"),
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
      contextWindow: reader.num("model.contextWindow", 32_768, 4_096, 2_000_000),
      reasoningReplay: reader.oneOf("model.reasoningReplay", "auto", ["auto", "always", "never"] as const),
    },
    maxSteps: reader.num("agent.maxSteps", 30, 1, 500),
    largeTaskSteps: reader.num("agent.largeTaskSteps", 24, 1, 60),
    maxTurnTokens: reader.num("agent.maxTurnTokens", 200_000, 10_000, 2_000_000),
    maxTurnSeconds: reader.num("agent.maxTurnSeconds", 600, 60, 7_200),
    largeTaskSeconds: reader.num("agent.largeTaskSeconds", 1_800, 60, 14_400),
    firstTokenSeconds: reader.num("agent.modelFirstTokenSeconds", 60, 5, 600),
    idleSeconds: reader.num("agent.modelIdleSeconds", 45, 5, 600),
    maxToolCallsPerBatch: reader.num("agent.maxToolCallsPerBatch", 8, 1, 32),
    toolTimeoutMs: reader.num("agent.toolTimeoutMs", 30_000, 1_000, 600_000),
    longToolTimeoutMs: reader.num("agent.longToolTimeoutMs", 600_000, 30_000, 3_600_000),
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
    attachments: {
      maxCount: reader.num("attachments.maxCount", 10, 1, 50),
      maxTotalChars: reader.num("attachments.maxTotalChars", 120_000, 10_000, 1_000_000),
      maxCharsPerItem: reader.num("attachments.maxCharsPerItem", 40_000, 2_000, 500_000),
    },
    focus: {
      autoAttach: reader.bool("focus.autoAttach", true),
      fallbackLines: reader.num("focus.fallbackLines", 30, 5, 200),
      maxLines: reader.num("focus.maxLines", 300, 20, 2_000),
      highlight: reader.bool("focus.highlight", true),
    },
    summary: {
      baseUrl: reader.str("summary.baseUrl", ""),
      model: reader.str("summary.model", ""),
      apiKeyId: reader.str("summary.apiKeyId", "beeCode.summaryApiKey"),
    },
    subagent: {
      enabled: reader.bool("subagent.enabled", true),
      baseUrl: reader.str("subagent.baseUrl", ""),
      model: reader.str("subagent.model", ""),
      apiKeyId: reader.str("subagent.apiKeyId", "beeCode.apiKey.subagent"),
      maxSteps: reader.num("subagent.maxSteps", 8, 1, 12),
      supportsVision: reader.oneOf("subagent.supportsVision", "auto", ["auto", "on", "off"] as const),
    },
  };

  return { config, problems: reader.problems };
}

/**
 * Reader with type validation: every `get` verifies the real type and the value range.
 *
 * Why not just write `cfg.get<number>(...)`: a generic only *claims* a type at **compile time**; at
 * runtime the value can very well be `"30"` (a user hand-writing a string in settings.json).
 */
class Reader {
  readonly problems: string[] = [];

  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  str(key: string, fallback: string): string {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "string") return this.bad(key, "a string", raw, fallback);
    return raw;
  }

  num(key: string, fallback: number, min: number, max: number): number {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return this.bad(key, "a number", raw, fallback);
    if (raw < min || raw > max) {
      this.problems.push(`beeCode.${key} is out of range [${min}, ${max}] (actual ${raw}); using the default ${fallback}`);
      return fallback;
    }
    return raw;
  }

  bool(key: string, fallback: boolean): boolean {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "boolean") return this.bad(key, "a boolean", raw, fallback);
    return raw;
  }

  oneOf<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "string" || !allowed.includes(raw as T)) {
      const expected = allowed.map((a) => `"${a}"`).join(" / ");
      this.problems.push(
        `beeCode.${key} must be one of ${expected}; actual value is ${safeJson(raw)}; using the default "${fallback}"`,
      );
      return fallback;
    }
    return raw as T;
  }

  strArray(key: string, fallback: string[]): string[] {
    const raw = this.cfg.get<unknown>(key);
    if (raw === undefined || raw === null) return [...fallback];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      return this.bad(key, "a string array", raw, fallback);
    }
    return [...(raw as string[])];
  }

  private bad<T>(key: string, expect: string, raw: unknown, fallback: T): T {
    this.problems.push(
      `beeCode.${key} must be ${expect}; actual type is ${typeOf(raw)} (${safeJson(raw)}); using the default ${safeJson(fallback)}`,
    );
    return fallback;
  }
}

/**
 * Replace `${workspaceFolder}` / `${workspaceFolder:name}` / `${userHome}` / `${env:X}` with real paths.
 *
 * ⚠️ `getConfiguration().get()` does **not** expand these placeholders for you -- you get the raw string.
 * With no workspace `${workspaceFolder}` expands to an empty string (rather than `process.cwd()`:
 * the extension host process cwd is usually the VS Code install directory, which is almost certainly
 * not what the user wants).
 */
export function resolvePlaceholders(raw: string, workspaceRoot?: string): string {
  if (!raw) return "";
  return raw
    .replace(/\$\{workspaceFolder(?::[^}]*)?\}/g, workspaceRoot ?? "")
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "")
    .trim();
}

/** One id per session; the shell does not interpret it, it only routes on it */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultInstruction(mode: Mode): string {
  switch (mode) {
    case "builder":
      return "Please generate changes based on the selected code.";
    case "debugger":
      return "Please investigate the problem in this code.";
    case "chat":
    default:
      return "Please explain this code.";
  }
}

/** Workspace roots (the first one when there are several; the kernel also receives all roots) */
export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** With no folder open, most of the extension's capabilities are moot (reading files, checkpoints, diff) */
export function isWorkspaceEmpty(): boolean {
  return workspaceRoots().length === 0;
}

/** For the footer/log (contains no secrets; baseUrl is redacted centrally by Logger) */
export function describeConfig(cfg: ShellConfig): string {
  const model = cfg.model.model || "<not configured>";
  const base = cfg.model.baseUrl || "<not configured>";
  const cwd = cfg.cwd || "<no workspace>";
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
