import * as vscode from "vscode";
import { toWorkspaceRelative } from "./paths";

/**
 * Cursor/selection -> the code block to send to the model.
 *
 * Rules (explicitly requested by the user):
 *   1. Prefer the **entire function containing the cursor** (including methods/constructors);
 *   2. Not inside a function -> degrade to "N lines above and below the cursor";
 *   3. Function too long (> maxLines) -> also degrade to N lines above and below, to avoid sending thousands of lines at once;
 *   4. Selections likewise: a selection that falls entirely inside one function -> expand to the whole function; spanning functions/blocks -> keep the selection +/- a little context.
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
  endLine: number; // 1-based (inclusive)
  kind: "function" | "block";
  symbol?: string;
  /** Downgraded/truncated because it was too long */
  truncated?: boolean;
}

export interface FocusInfo extends FocusRange {
  path: string;
  /** Line the cursor is on (1-based) */
  line: number;
  untitled?: boolean;
  text: string;
}

/** Only these kinds count as a "function" */
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

/** Find the innermost function containing the given line (1-based) */
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

/** Pure function: compute the range to read (easy to unit test, no vscode involved) */
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
    // Function too large: degrade to the area around the cursor so thousands of lines are not sent at once
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

/** Selection variant: expand to the function only if the whole selection lies within one, otherwise keep the selection + a little context */
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

/** Read the current editor's symbol table; return an empty array instead of throwing when there is no LSP support */
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
 * Get "the code near the current cursor".
 *
 * No active editor / a read-only document (diff preview etc.) -> returns undefined.
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

/** Get the code block for a selection (or a cursor position); used by the "attach selection" command */
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
