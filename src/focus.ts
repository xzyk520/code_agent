import * as vscode from "vscode";
import { toWorkspaceRelative } from "./paths";

/**
 * 光标/选区 → 要送给模型的代码块。
 *
 * 规则（用户明确要求）：
 *   1. 优先取**包含光标的整个函数**（含方法/构造函数）；
 *   2. 不在函数里 → 退化成"光标上下 N 行"；
 *   3. 函数太长（> maxLines）→ 也退化成上下 N 行，避免一次塞几千行；
 *   4. 选区同理：整个选区落在同一个函数里 → 扩成整个函数；跨函数/跨块 → 保留选区 ± 少量上下文。
 */

export interface SymbolNode {
  name: string;
  kind: number;
  startLine: number;
  endLine: number;
  children: SymbolNode[];
}

export interface FocusRange {
  startLine: number; // 1-based
  endLine: number; // 1-based（含）
  kind: "function" | "block";
  symbol?: string;
  /** 因为太长而被降级/截断 */
  truncated?: boolean;
}

export interface FocusInfo extends FocusRange {
  path: string;
  /** 光标所在行（1-based） */
  line: number;
  untitled?: boolean;
  text: string;
}

/** 只有这些 kind 才算"函数" */
const FUNCTION_KINDS = new Set<number>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

export function toSymbolNodes(symbols: readonly vscode.DocumentSymbol[]): SymbolNode[] {
  return symbols.map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.range.start.line + 1,
    endLine: symbol.range.end.line + 1,
    children: toSymbolNodes(symbol.children ?? []),
  }));
}

/** 找包含该行（1-based）的最内层函数 */
export function findEnclosingFunction(nodes: readonly SymbolNode[], line: number): SymbolNode | undefined {
  let best: SymbolNode | undefined;
  for (const node of nodes) {
    if (line < node.startLine || line > node.endLine) continue;
    const inner = findEnclosingFunction(node.children, line);
    if (inner) {
      if (!best || inner.endLine - inner.startLine < best.endLine - best.startLine) best = inner;
      continue;
    }
    if (FUNCTION_KINDS.has(node.kind)) {
      if (!best || node.endLine - node.startLine < best.endLine - best.startLine) best = node;
    }
  }
  return best;
}

/** 纯函数：算出一个要读的范围（便于单测，不碰 vscode） */
export function computeFocusRange(
  line: number,
  nodes: readonly SymbolNode[],
  options: { fallbackLines: number; maxLines: number; docLineCount: number },
): FocusRange {
  const clampStart = (value: number) => Math.max(1, Math.min(value, options.docLineCount));
  const clampEnd = (value: number) => Math.max(1, Math.min(value, options.docLineCount));

  const fn = findEnclosingFunction(nodes, line);
  if (fn) {
    const length = fn.endLine - fn.startLine + 1;
    if (length <= options.maxLines) {
      return { startLine: clampStart(fn.startLine), endLine: clampEnd(fn.endLine), kind: "function", symbol: fn.name };
    }
    // 函数太大：退化成光标附近，避免一次送几千行
    const start = clampStart(line - options.fallbackLines);
    const end = clampEnd(line + options.fallbackLines);
    return { startLine: start, endLine: end, kind: "block", symbol: fn.name, truncated: true };
  }

  return {
    startLine: clampStart(line - options.fallbackLines),
    endLine: clampEnd(line + options.fallbackLines),
    kind: "block",
  };
}

/** 选区版本：整个选区落在同一函数内才扩成函数，否则保留选区 + 少量上下文 */
export function computeSelectionRange(
  startLine: number,
  endLine: number,
  nodes: readonly SymbolNode[],
  options: { fallbackLines: number; maxLines: number; docLineCount: number },
): FocusRange {
  const fn = findEnclosingFunction(nodes, startLine);
  if (fn && endLine <= fn.endLine && fn.endLine - fn.startLine + 1 <= options.maxLines) {
    return { startLine: fn.startLine, endLine: fn.endLine, kind: "function", symbol: fn.name };
  }
  const pad = 2;
  return {
    startLine: Math.max(1, startLine - pad),
    endLine: Math.min(options.docLineCount, endLine + pad),
    kind: "block",
  };
}

/** 读取当前编辑器的符号表；没有 LSP 支持时返回空数组而不是抛错 */
async function documentSymbols(uri: vscode.Uri): Promise<SymbolNode[]> {
  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri,
    );
    return toSymbolNodes(symbols ?? []);
  } catch {
    return [];
  }
}

export interface FocusOptions {
  fallbackLines: number;
  maxLines: number;
}

/**
 * 取"当前光标附近的代码"。
 *
 * 无活动编辑器 / 只读文档（diff 预览等）→ 返回 undefined。
 */
export async function readFocusAtCursor(
  options: FocusOptions,
): Promise<FocusInfo | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const doc = editor.document;
  if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") return undefined;

  const line = editor.selection.active.line + 1;
  const nodes = await documentSymbols(doc.uri);
  const range = computeFocusRange(line, nodes, {
    fallbackLines: options.fallbackLines,
    maxLines: options.maxLines,
    docLineCount: doc.lineCount,
  });

  const untitled = doc.uri.scheme === "untitled";
  const path = untitled ? doc.uri.path.replace(/^\//, "") : toWorkspaceRelative(doc.uri.fsPath);
  return {
    path,
    line,
    startLine: range.startLine,
    endLine: range.endLine,
    kind: range.kind,
    symbol: range.symbol,
    truncated: range.truncated,
    untitled: untitled || undefined,
    text: doc.getText(
      new vscode.Range(range.startLine - 1, 0, range.endLine - 1, doc.lineAt(range.endLine - 1).text.length),
    ),
  };
}

/** 取一个选区（或一个光标位置）对应的代码块；供「附加选区」命令使用 */
export async function readFocusForSelection(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  options: FocusOptions,
): Promise<FocusInfo | undefined> {
  const doc = editor.document;
  if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") return undefined;

  const nodes = await documentSymbols(doc.uri);
  const opts = { fallbackLines: options.fallbackLines, maxLines: options.maxLines, docLineCount: doc.lineCount };
  const range = selection.isEmpty
    ? computeFocusRange(selection.active.line + 1, nodes, opts)
    : computeSelectionRange(selection.start.line + 1, selection.end.line + 1, nodes, opts);

  const untitled = doc.uri.scheme === "untitled";
  const path = untitled ? doc.uri.path.replace(/^\//, "") : toWorkspaceRelative(doc.uri.fsPath);
  return {
    path,
    line: selection.active.line + 1,
    startLine: range.startLine,
    endLine: range.endLine,
    kind: range.kind,
    symbol: range.symbol,
    truncated: range.truncated,
    untitled: untitled || undefined,
    text: doc.getText(
      new vscode.Range(range.startLine - 1, 0, range.endLine - 1, doc.lineAt(range.endLine - 1).text.length),
    ),
  };
}
