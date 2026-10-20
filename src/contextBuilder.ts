import type { ChatMessage } from "./protocol";
import type { StoredMessage } from "./sessionStore";

/**
 * 模型上下文构建：**完整历史 ≠ 模型上下文**。
 *
 * 落盘的 transcript 可以无限长（用户随时回看），但每次发给模型的必须是"够用且不爆"的子集。
 * 这一层就是那个裁剪器，纯函数、可单测，不依赖 vscode。
 *
 * 分层（对应 docs/architecture.md §9.4）：
 *   L1 摘要摘要（早前轮次的压缩结果，≤1.5k token）
 *   L2 最近 N 条逐字（默认 8 条）
 *   L3 当前轮的附件/检索结果（由内核自己加，不在 history 里）
 *
 * 触发压缩的时机：折叠后仍超预算 → 从最旧的逐字消息开始丢。
 */

export interface ContextBudget {
  /** 最近多少条消息逐字保留 */
  recentMessages: number;
  /** 历史部分（摘要 + 逐字）的 token 上限 */
  maxTokens: number;
}

export const DEFAULT_BUDGET: ContextBudget = { recentMessages: 8, maxTokens: 6_000 };

export interface BuiltContext {
  /** 早前轮次的摘要（没有则 undefined） */
  summary?: string;
  /** 逐字保留的消息 */
  messages: ChatMessage[];
  /** 被折叠进摘要 / 被丢弃的条数（可观测性） */
  folded: number;
  estimatedTokens: number;
}

/**
 * 粗估 token：CJK 约 1 token/字，ASCII 约 1 token/4 字符。
 *
 * 不追求精确——真实分词在模型侧，这里只需要一个"别超预算"的量级。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1; // 中日韩
    else if (code >= 0xac00 && code <= 0xd7af) cjk += 1; // 韩文
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1; // 全角标点
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

  let kept = recent.map((m) => ({ role: m.role, text: m.text }) as ChatMessage);
  let folded = older.length;

  // 摘要本身可能就超预算：**保留最新的行**（越靠后越新），从最旧的行开始丢
  if (summary) {
    const summaryTokens = estimateTokens(summary);
    if (summaryTokens > budget.maxTokens / 2) {
      summary = truncateSummaryFromFront(summary, Math.floor(budget.maxTokens / 2));
    }
  }

  // 仍超预算：从最旧的逐字消息开始丢（允许清空——当前用户输入由调用方单独传 text）
  let tokens = (summary ? estimateTokens(summary) : 0) + kept.reduce((n, m) => n + estimateTokens(m.text), 0);
  while (tokens > budget.maxTokens && kept.length > 0) {
    const dropped = kept.shift();
    if (dropped) tokens -= estimateTokens(dropped.text);
    folded += 1;
  }

  return { summary, messages: kept, folded, estimatedTokens: tokens + (summary ? 0 : 0) };
}

/**
 * 机械摘要（不调模型）：提取"后续还用得上"的锚点。
 *
 * 为什么不用 LLM 摘要：这一层要在同步路径上跑（面板一刷新就要算），
 * 而且重载后可能没有可用的模型。等内核实现了 `compact`，可以换成模型摘要，
 * 接口保持不变。机械摘要保住了最有用的三类信息：用户要什么、动过哪些文件、出过什么错。
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
  if (errors.length > 0) lines.push(`出现过的问题：${errors.join("；")}`);

  return clip(lines.join("\n"), maxChars);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 摘要超预算时保留**较新**的部分：逐行从头部删，而不是截断字符串。
 *
 * 摘要行按时间追加（旧 → 新），所以"保留开头"会丢掉最近结论；
 * 这里反过来，只丢最旧的几行，并在开头注明省略了多少行。
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
  // 按字符逐步逼近（够用即可，不做精确分词）
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}
