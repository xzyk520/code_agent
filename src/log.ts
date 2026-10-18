import * as vscode from "vscode";

/**
 * 日志与脱敏。
 *
 * 规则：**任何**可能带凭据的字符串都先过 redact() 再写进日志 / 诊断包 / 错误消息。
 * 这比「记得别打印」可靠 —— 后者一定会忘。
 *
 * 三条通道能力：
 *   1. **落盘**：用 `createOutputChannel(name, { log: true })` 拿到 LogOutputChannel，
 *      内容会被 VS Code 写进日志文件（`Developer: Open Logs Folder`），**进程崩溃后仍可查**。
 *   2. **级别可调**：用户在输出面板下拉里选 Trace/Debug/Info/…，不用改代码。
 *   3. **可导出**：内存里另存最近 N 行（`OutputChannel` 只写不读，诊断包只能靠自己留一份）。
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
  //                Slack(xox?-形) Google(AIza / OAuth ya29.) 通用(sk_live_/rk_live_)
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

/** 内存里保留的最近行数（供诊断包使用；LogOutputChannel 的内容同样读不回来） */
const RECENT_LIMIT = 500;

/** stderr 单行最大长度：防止对端一直不换行导致缓冲无限增长 */
const STDERR_LINE_LIMIT = 64 * 1024;

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;
  private readonly stderrChannel: vscode.LogOutputChannel;
  private readonly recent: string[] = [];
  private readonly recentStderr: string[] = [];
  /** stderr 是流式 chunk（可能是半行），攒到换行再作为一条日志写出 */
  private stderrPending = "";

  constructor(name = "Bee Code") {
    // `{ log: true }` → LogOutputChannel：自动落盘 + 级别可调 + 统一格式
    this.channel = vscode.window.createOutputChannel(name, { log: true });
    this.stderrChannel = vscode.window.createOutputChannel(`${name} · 内核 stderr`, { log: true });
  }

  debug(msg: string, fields?: unknown): void { this.write("debug", msg, fields); }
  info(msg: string, fields?: unknown): void { this.write("info", msg, fields); }
  warn(msg: string, fields?: unknown): void { this.write("warn", msg, fields); }
  error(msg: string, fields?: unknown): void { this.write("error", msg, fields); }

  /**
   * 内核 stderr 单独一条通道：Python traceback 很长，别污染主日志。
   *
   * ⚠️ 这里**必须脱敏**：Python 侧可能把完整 URL（含 `?api_key=`）打进 traceback，
   * 不过 redact 就等于开了个绕过通道。
   *
   * stderr 是流式的，一次 chunk 可能是半行，所以按行缓冲后再写，
   * 顺便按内容分级（Traceback/Error → error 级，日志里更好找）。
   */
  coreStderr(chunk: string): void {
    this.stderrPending += chunk;
    let index: number;
    while ((index = this.stderrPending.indexOf("\n")) >= 0) {
      const line = this.stderrPending.slice(0, index).replace(/\r$/, "");
      this.stderrPending = this.stderrPending.slice(index + 1);
      this.emitStderrLine(line);
    }
    // 一直不换行时强制切一刀，避免缓冲无限增长
    if (this.stderrPending.length > STDERR_LINE_LIMIT) {
      this.emitStderrLine(this.stderrPending);
      this.stderrPending = "";
    }
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

  dispose(): void {
    // 收尾：把没有换行结尾的最后半行也落下去
    if (this.stderrPending.length > 0) {
      this.emitStderrLine(this.stderrPending);
      this.stderrPending = "";
    }
    this.channel.dispose();
    this.stderrChannel.dispose();
  }

  // ───────────────────────── 内部 ─────────────────────────

  private write(level: LogLevel, msg: string, fields?: unknown): void {
    const suffix = fields === undefined ? "" : ` ${safeJson(fields)}`;
    const text = `${redact(msg)}${suffix}`;
    // VS Code 会给 log channel 自动加时间戳与级别前缀，这里不再手拼
    switch (level) {
      case "debug": this.channel.debug(text); break;
      case "info": this.channel.info(text); break;
      case "warn": this.channel.warn(text); break;
      case "error": this.channel.error(text); break;
    }
    this.pushRecent(this.recent, `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${text}`);
  }

  private emitStderrLine(rawLine: string): void {
    const line = redact(rawLine);
    if (line.trim().length === 0) return;
    if (isErrorLine(line)) this.stderrChannel.error(line);
    else this.stderrChannel.info(line);
    this.pushRecent(this.recentStderr, line);
  }

  /** 有界队列：超出容量就从最旧的丢。诊断包只关心"最近发生了什么"。 */
  private pushRecent(target: string[], text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) target.push(line);
    }
    const overflow = target.length - RECENT_LIMIT;
    if (overflow > 0) target.splice(0, overflow);
  }
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Python traceback / 异常行 → 用 error 级写，日志里更醒目 */
function isErrorLine(line: string): boolean {
  return /(^|\s)(Traceback \(most recent call last\)|[A-Za-z_][A-Za-z0-9_.]*(Error|Exception):)/.test(line);
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return redact(value);
  try {
    return redact(JSON.stringify(value) ?? String(value));
  } catch {
    return "<unserializable>";
  }
}
