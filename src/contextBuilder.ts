import type { ChatMessage } from "./protocol";
import type { StoredMessage } from "./sessionStore";

/**
 * Model context construction: **the full history != the model context**.
 *
 * The transcript on disk can grow without bound (the user may look back any time), but what is sent to
 * the model each time must be a subset that is "enough without blowing up". This layer is that
 * trimmer: pure functions, unit-testable, no vscode dependency.
 *
 * Layers (matching docs/architecture.md §9.4):
 *   L1 summary of summaries (compressed result of earlier turns, <=1.5k tokens)
 *   L2 the last N messages verbatim (8 by default)
 *   L3 attachments/retrieval results for the current turn (added by the kernel itself, not part of history)
 *
 * When compaction triggers: still over budget after folding -> drop the oldest verbatim messages first.
 */

export interface ContextBudget {
  /** How many of the most recent messages to keep verbatim */
  recentMessages: number;
  /** Token limit for the history part (summary + verbatim) */
  maxTokens: number;
}

export const DEFAULT_BUDGET: ContextBudget = { recentMessages: 8, maxTokens: 6_000 };

export interface BuiltContext {
  /** Summary of earlier turns (undefined when there is none) */
  summary?: string;
  /** Messages kept verbatim */
  messages: ChatMessage[];
  /** How many entries were folded into the summary / dropped (observability) */
  folded: number;
  estimatedTokens: number;
}

/**
 * Rough token estimate: CJK is about 1 token per character, ASCII about 1 token per 4 characters.
 *
 * Precision is not the goal -- real tokenization happens on the model side; all that is needed here is
 * an order of magnitude so we "do not exceed the budget".
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1; // CJK
    else if (code >= 0xac00 && code <= 0xd7af) cjk += 1; // Korean
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1; // full-width punctuation
  }
  const ascii = text.length - cjk;
  return Math.ceil(cjk + ascii / 4);
}

export function buildContext(
  messages: StoredMessage[],
  previousSummary?: string,
  budget: ContextBudget = DEFAULT_BUDGET,
): BuiltContext {
  const recentCount = Math.max(0, budget.recentMessages);
  const splitAt = Math.max(0, messages.length - recentCount);
  const older = messages.slice(0, splitAt);
  const recent = messages.slice(splitAt);

  const summaryParts: string[] = [];
  if (previousSummary) summaryParts.push(previousSummary);
  if (older.length > 0) summaryParts.push(summarize(older));
  let summary = summaryParts.filter((s) => s.trim().length > 0).join("\n\n") || undefined;

  let kept = recent.map((m) => ({ role: m.role, text: m.text, ...(m.diagrams ? { diagrams: m.diagrams } : {}) }) as ChatMessage);
  let folded = older.length;

  // The summary itself may be over budget: **keep the newest lines** (later = newer) and drop from the oldest
  if (summary) {
    const summaryTokens = estimateTokens(summary);
    if (summaryTokens > budget.maxTokens / 2) {
      summary = truncateSummaryFromFront(summary, Math.floor(budget.maxTokens / 2));
    }
  }

  // Still over budget: drop the oldest verbatim messages first (emptying is allowed -- the current user input is passed separately by the caller as text)
  const messageTokens = (m: ChatMessage): number =>
    estimateTokens(m.text) + (m.diagrams ?? []).reduce((sum, d) => sum + estimateTokens(d.source), 0);
  let tokens = (summary ? estimateTokens(summary) : 0) + kept.reduce((n, m) => n + messageTokens(m), 0);
  while (tokens > budget.maxTokens && kept.length > 0) {
    const dropped = kept.shift();
    if (dropped) tokens -= messageTokens(dropped);
    folded += 1;
  }

  return { summary, messages: kept, folded, estimatedTokens: tokens + (summary ? 0 : 0) };
}

/**
 * Mechanical summary (no model call): extract the anchors that "will still be useful later".
 *
 * Why not use an LLM summary: this layer runs on the synchronous path (it must be computed as soon as
 * the panel refreshes), and after a reload there may be no model available. Once the kernel implements
 * `compact` the summary can be model-generated with this interface unchanged. The mechanical summary
 * preserves the three most useful kinds of information: what the user wants, which files were touched,
 * and which errors occurred.
 */
export function summarize(messages: StoredMessage[], maxChars = 1_200): string {
  if (messages.length === 0) return "";

  const asks: string[] = [];
  const files = new Set<string>();
  const errors: string[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const firstLine = m.text.split("\n")[0]?.trim() ?? "";
      if (firstLine) asks.push(clip(firstLine, 60));
    }
    for (const match of m.text.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|css|json|md|ya?ml|toml)/g)) {
      if (files.size < 12) files.add(match[0]);
    }
    if (m.role === "system" && /失败|错误|error|Error|中断/.test(m.text)) {
      if (errors.length < 3) errors.push(clip(m.text.replace(/\s+/g, " "), 80));
    }
  }

  const lines: string[] = [`[早前对话摘要 · ${messages.length} 条消息]`];
  if (asks.length > 0) lines.push(`用户先后要求：${asks.slice(-6).join("；")}`);
  if (files.size > 0) lines.push(`涉及文件：${[...files].join(", ")}`);
  const diagramTitles = new Set<string>();
  for (const message of messages) {
    for (const diagram of message.diagrams ?? []) {
      if (diagramTitles.size >= 5) break;
      const label = (diagram.title || diagram.kind || "mermaid").trim();
      if (label) diagramTitles.add(label);
    }
  }
  if (diagramTitles.size > 0) {
    lines.push(`涉及图示：${[...diagramTitles].join("、")}`);
  }
  if (errors.length > 0) lines.push(`出现过的问题：${errors.join("；")}`);

  return clip(lines.join("\n"), maxChars);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * When the summary is over budget, keep the **newer** part: delete line by line from the head rather
 * than truncating the string.
 *
 * Summary lines are appended chronologically (old -> new), so "keep the beginning" would lose the latest
 * conclusions; this does the reverse, dropping only the oldest lines and noting at the top how many were
 * omitted.
 */
function truncateSummaryFromFront(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let dropped = 0;
  while (lines.length > 1 && estimateTokens(lines.join("\n")) > maxTokens) {
    lines.shift();
    dropped += 1;
  }
  const prefix = dropped > 0 ? `…（更早的 ${dropped} 行摘要已省略）` : "";
  let out = [prefix, ...lines].filter((line) => line.length > 0).join("\n");
  if (estimateTokens(out) > maxTokens) out = truncateToTokens(out, maxTokens);
  return out;
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  // Approximate character by character (good enough; no precise tokenization)
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}
