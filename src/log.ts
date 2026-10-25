import * as vscode from "vscode";

/**
 * Logging and redaction.
 *
 * Rule: **any** string that could carry credentials goes through redact() before it is written to the
 * log / diagnostics bundle / error message. This is more reliable than "remember not to print it" --
 * the latter is always forgotten.
 *
 * Three channel capabilities:
 *   1. **Persisted**: `createOutputChannel(name, { log: true })` returns a LogOutputChannel, whose
 *      content VS Code writes to a log file (`Developer: Open Logs Folder`), so it is **still
 *      inspectable after a process crash**.
 *   2. **Adjustable level**: users pick Trace/Debug/Info/... in the output panel dropdown, no code change.
 *   3. **Exportable**: the most recent N lines are also kept in memory (`OutputChannel` is write-only,
 *      so the diagnostics bundle has to keep its own copy).
 */

/**
 * Credential rules. Each one **keeps the prefix** (`$1`) so the log still shows "there used to be a
 * token here" instead of the whole thing vanishing and misleading the reader.
 *
 * Coverage is grouped by vendor: this project's selling point is "any OpenAI-compatible endpoint", so
 * recognizing only `sk-` is not enough.
 */
const CREDENTIAL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // OpenAI / DeepSeek / Anthropic / Moonshot and friends: the sk- prefixed family
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***REDACTED***"],
  // Other vendor prefixes: Groq(gsk_) HuggingFace(hf_) GitHub(ghp_/gho_/ghs_/github_pat_)
  //                Slack(xox?-shaped) Google(AIza / OAuth ya29.) generic(sk_live_/rk_live_)
  [
    /\b(gsk_|hf_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AIza|ya29\.|sk_live_|rk_live_)[A-Za-z0-9_.-]{10,}/g,
    "$1***REDACTED***",
  ],
  // AWS AKIA/ASIA: exactly 16 uppercase alphanumeric characters
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1***REDACTED***"],
  // Authorization headers
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1***REDACTED***"],
  // URL query parameters (including signature-style ones)
  [/([?&](?:api[-_]?key|access[-_]?token|token|key|sig|signature|password)=)[^&\s]+/gi, "$1***REDACTED***"],
  // Fields in JSON / config (both quote styles covered)
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

/** Number of recent lines kept in memory (for the diagnostics bundle; LogOutputChannel content cannot be read back either) */
const RECENT_LIMIT = 500;

/** Max length of a single stderr line: prevents unbounded buffer growth when the peer never emits a newline */
const STDERR_LINE_LIMIT = 64 * 1024;

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;
  private readonly stderrChannel: vscode.LogOutputChannel;
  private readonly recent: string[] = [];
  private readonly recentStderr: string[] = [];
  /** stderr arrives as stream chunks (possibly half a line); buffer until a newline, then emit one log entry */
  private stderrPending = "";
  private disposed = false;

  constructor(name = "Bee Code") {
    // `{ log: true }` -> LogOutputChannel: automatic persistence + adjustable level + uniform format
    this.channel = vscode.window.createOutputChannel(name, { log: true });
    this.stderrChannel = vscode.window.createOutputChannel(`${name} · Core stderr`, { log: true });
  }

  debug(msg: string, fields?: unknown): void { this.write("debug", msg, fields); }
  info(msg: string, fields?: unknown): void { this.write("info", msg, fields); }
  warn(msg: string, fields?: unknown): void { this.write("warn", msg, fields); }
  error(msg: string, fields?: unknown): void { this.write("error", msg, fields); }

  /**
   * A separate channel for kernel stderr: Python tracebacks are long, so do not pollute the main log.
   *
   * ⚠️ This **must** be redacted: the Python side may dump a full URL (including `?api_key=`) into a
   * traceback, and skipping redact would open a bypass channel.
   *
   * stderr is streamed and one chunk may be half a line, so buffer by line before writing, and grade
   * by content along the way (Traceback/Error -> error level, easier to find in the log).
   */
  coreStderr(chunk: string): void {
    this.stderrPending += chunk;
    let index: number;
    while ((index = this.stderrPending.indexOf("\n")) >= 0) {
      const line = this.stderrPending.slice(0, index).replace(/\r$/, "");
      this.stderrPending = this.stderrPending.slice(index + 1);
      this.emitStderrLine(line);
    }
    // Force a cut when no newline ever arrives, to keep the buffer from growing without bound
    if (this.stderrPending.length > STDERR_LINE_LIMIT) {
      this.emitStderrLine(this.stderrPending);
      this.stderrPending = "";
    }
  }

  show(): void { this.channel.show(true); }
  showStderr(): void { this.stderrChannel.show(true); }

  /** Recent main log lines (already redacted; for the diagnostics bundle/copying) */
  snapshot(): string[] {
    return [...this.recent];
  }

  /** Recent kernel stderr lines (already redacted) */
  snapshotStderr(): string[] {
    return [...this.recentStderr];
  }

  /** Idempotent: a repeated dispose does not close the channels twice or write leftover lines twice */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Wrap up: flush the trailing partial line that has no newline
    if (this.stderrPending.length > 0) {
      this.emitStderrLine(this.stderrPending);
      this.stderrPending = "";
    }
    this.channel.dispose();
    this.stderrChannel.dispose();
  }

  // ───────────────────────── internals ─────────────────────────

  private write(level: LogLevel, msg: string, fields?: unknown): void {
    const suffix = fields === undefined ? "" : ` ${safeJson(fields)}`;
    const text = `${redact(msg)}${suffix}`;
    // VS Code adds the timestamp and level prefix to log channels automatically, so do not build them by hand
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

  /** Bounded queue: drop the oldest entries once capacity is exceeded. The diagnostics bundle only cares about "what just happened". */
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

/** Python traceback / exception lines -> written at error level, more visible in the log */
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
