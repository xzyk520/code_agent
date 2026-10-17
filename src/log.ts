import * as vscode from "vscode";

/**
 * 日志与脱敏。
 *
 * 规则：**任何**可能带凭据的字符串都先过 redact() 再写进 OutputChannel / 通知 / 错误消息。
 * 这比「记得别打印」可靠 —— 后者一定会忘。
 */

export function redact(input: string): string {
  return input
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***REDACTED***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1***REDACTED***")
    .replace(/([?&](?:api_?key|token|access_token|key)=)[^&\s]+/gi, "$1***REDACTED***")
    .replace(/("(?:apiKey|api_key|authorization|token)"\s*:\s*")[^"]+(")/gi, "$1***REDACTED***$2");
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private readonly stderrChannel: vscode.OutputChannel;

  constructor(name = "Bee Code") {
    this.channel = vscode.window.createOutputChannel(name);
    this.stderrChannel = vscode.window.createOutputChannel(`${name} · 内核 stderr`);
  }

  debug(msg: string, fields?: unknown): void { this.write("debug", msg, fields); }
  info(msg: string, fields?: unknown): void { this.write("info", msg, fields); }
  warn(msg: string, fields?: unknown): void { this.write("warn", msg, fields); }
  error(msg: string, fields?: unknown): void { this.write("error", msg, fields); }

  /** 内核 stderr 单独一个面板：Python traceback 很长，别污染主日志 */
  coreStderr(chunk: string): void {
    this.stderrChannel.append(chunk);
  }

  show(): void { this.channel.show(true); }
  showStderr(): void { this.stderrChannel.show(true); }

  private write(level: LogLevel, msg: string, fields?: unknown): void {
    const stamp = new Date().toISOString().slice(11, 23);
    const suffix = fields === undefined ? "" : ` ${safeJson(fields)}`;
    this.channel.appendLine(`[${stamp}] ${level.toUpperCase().padEnd(5)} ${redact(msg)}${suffix}`);
  }

  dispose(): void {
    this.channel.dispose();
    this.stderrChannel.dispose();
  }
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return redact(value);
  try {
    return redact(JSON.stringify(value));
  } catch {
    return "<unserializable>";
  }
}
