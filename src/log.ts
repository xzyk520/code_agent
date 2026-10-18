import * as vscode from "vscode";

/**
 * 日志与脱敏。
 *
 * 规则：**任何**可能带凭据的字符串都先过 redact() 再写进 OutputChannel / 诊断包 / 错误消息。
 * 这比「记得别打印」可靠 —— 后者一定会忘。
 */

/**
 * 凭据规则。每条都**保留前缀**（`$1`），这样日志里还能看出"这里本来有个 token"，
 * 而不是整段消失导致误判。
 *
 * 覆盖面按厂商分组：本项目的卖点是「任意 OpenAI 兼容端点」，所以不能只认 `sk-`。
 */
const CREDENTIAL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // OpenAI / DeepSeek / Anthropic / Moonshot 等：sk- 前缀家族
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***REDACTED***"],
  // 其他厂商前缀：Groq(gsk_) HuggingFace(hf_) GitHub(ghp_/gho_/ghs_/github_pat_)
  //                Slack(xox?-形) Google(AIza / OAuth ya29.) 通用(sk_live_ 之类)
  [
    /\b(gsk_|hf_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AIza|ya29\.|sk_live_|rk_live_)[A-Za-z0-9_.-]{10,}/g,
    "$1***REDACTED***",
  ],
  // AWS AKIA/ASIA：固定 16 位大写字母数字
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1***REDACTED***"],
  // 认证头
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1***REDACTED***"],
  // URL 查询参数（含签名类）
  [/([?&](?:api[-_]?key|access[-_]?token|token|key|sig|signature|password)=)[^&\s]+/gi, "$1***REDACTED***"],
  // JSON / 配置里的字段（单双引号都覆盖）
  [
    /(["'](?:api[-_]?key|authorization|access[-_]?token|token|secret|password)["']\s*:\s*["'])[^"']+(["'])/gi,
    "$1***REDACTED***$2",
  ],
];

export function redact(input: string): string {
  let output = input;
  for (const [pattern, replacement] of CREDENTIAL_RULES) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 内存里保留的最近行数（供诊断包使用；OutputChannel 的内容是读不回来的） */
const RECENT_LIMIT = 500;

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private readonly stderrChannel: vscode.OutputChannel;
  private readonly recent: string[] = [];
  private readonly recentStderr: string[] = [];

  constructor(name = "Bee Code") {
    this.channel = vscode.window.createOutputChannel(name);
    this.stderrChannel = vscode.window.createOutputChannel(`${name} · 内核 stderr`);
  }

  debug(msg: string, fields?: unknown): void { this.write("debug", msg, fields); }
  info(msg: string, fields?: unknown): void { this.write("info", msg, fields); }
  warn(msg: string, fields?: unknown): void { this.write("warn", msg, fields); }
  error(msg: string, fields?: unknown): void { this.write("error", msg, fields); }

  /**
   * 内核 stderr 单独一个面板：Python traceback 很长，别污染主日志。
   *
   * ⚠️ 这里**也必须脱敏**：Python 侧可能把完整 URL（含 `?api_key=`）打进 traceback，
   * 不过 redact 就等于开了个绕过通道。
   */
  coreStderr(chunk: string): void {
    const safe = redact(chunk);
    this.stderrChannel.append(safe);
    this.pushRecent(this.recentStderr, safe);
  }

  show(): void { this.channel.show(true); }
  showStderr(): void { this.stderrChannel.show(true); }

  /** 最近的主日志（已脱敏，供诊断包/复制用） */
  snapshot(): string[] {
    return [...this.recent];
  }

  /** 最近的内核 stderr（已脱敏） */
  snapshotStderr(): string[] {
    return [...this.recentStderr];
  }

  private write(level: LogLevel, msg: string, fields?: unknown): void {
    const stamp = new Date().toISOString().slice(11, 23);
    const suffix = fields === undefined ? "" : ` ${safeJson(fields)}`;
    const line = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${redact(msg)}${suffix}`;
    this.channel.appendLine(line);
    this.pushRecent(this.recent, line);
  }

  /** 环形缓冲：stderr 是流式 chunk，可能一次带很多行，按行拆开存 */
  private pushRecent(target: string[], text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      target.push(line);
    }
    const overflow = target.length - RECENT_LIMIT;
    if (overflow > 0) target.splice(0, overflow);
  }

  dispose(): void {
    this.channel.dispose();
    this.stderrChannel.dispose();
  }
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return redact(value);
  try {
    return redact(JSON.stringify(value) ?? String(value));
  } catch {
    return "<unserializable>";
  }
}
