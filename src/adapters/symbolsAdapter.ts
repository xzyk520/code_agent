import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { isInside, resolveTarget, toWorkspaceRelative } from "../paths";
import type {
  ReferenceHitDto,
  SymbolDto,
  SymbolHitDto,
  SymbolsOutlineParams,
  SymbolsOutlineResult,
  SymbolsReferencesParams,
  SymbolsReferencesResult,
  SymbolsSearchParams,
  SymbolsSearchResult,
} from "../protocol";
import { isIgnored } from "../workspaceIgnore";

const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 500;
const DEFAULT_REF_LIMIT = 200;
const MAX_REF_LIMIT = 1_000;
/** The fallback path scans at most this many files (candidates already pre-filtered by name) */
const FALLBACK_FILE_CAP = 40;
const FALLBACK_FILE_BYTES = 512 * 1024;

/**
 * Symbol service: three actions for three kinds of question.
 *
 *   outline    → which functions/classes are in this file (per file)
 *   search     → **which file defines something called X** (whole workspace, definition level)
 *   references → **where X is used** (whole workspace, reference level)
 *
 * None of them read file content; they return only "positions". Use `fs.read` / `read_symbol` when you need content.
 *
 * Every symbol carries **two** ranges:
 *   - `range`: the whole symbol (including leading comments/docstring) — `read_symbol` uses it, so reading a function can include its comments
 *   - `selection`: the identifier itself — `references` uses it; the start line of `range` often lands inside a comment,
 *     where the reference provider cannot resolve the symbol and returns empty results (a latent bug before v0.3)
 *
 * ⚠️ The return type has two shapes (depending on the provider the language extension registers):
 *   - DocumentSymbol[]: has range / selectionRange / children
 *   - SymbolInformation[]: flat, only location + containerName
 * Both must be handled, or things break as soon as you switch languages.
 */
export function createSymbolsAdapter(logger: Logger) {
  const outline = async (path: string, ctx?: InboundRequestContext): Promise<SymbolsOutlineResult> => {
    ctx?.throwIfCancelled();
    const uri = resolveTarget(path);

    const raw = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      "vscode.executeDocumentSymbolProvider",
      uri,
    );
    if (!raw || raw.length === 0) {
      logger.debug(`symbols.outline ${path} → 无 provider（该语言没装语言扩展？）`);
      return { symbols: [], source: "none" };
    }

    const symbols: SymbolDto[] = [];
    const visit = (node: vscode.DocumentSymbol | vscode.SymbolInformation, container?: string): void => {
      if (node instanceof vscode.DocumentSymbol) {
        symbols.push({
          name: node.name,
          kind: symbolKindName(node.kind),
          container,
          range: { startLine: node.range.start.line + 1, endLine: node.range.end.line + 1 },
          selection: {
            startLine: node.selectionRange.start.line + 1,
            startColumn: node.selectionRange.start.character + 1,
            endLine: node.selectionRange.end.line + 1,
            endColumn: node.selectionRange.end.character + 1,
          },
        });
        for (const child of node.children) visit(child, container ? `${container}.${node.name}` : node.name);
      } else {
        // Flat shape: the provider usually supplies containerName (which class it belongs to); don't drop it
        const own = node.containerName || container;
        symbols.push({
          name: node.name,
          kind: symbolKindName(node.kind),
          container: own || undefined,
          range: {
            startLine: node.location.range.start.line + 1,
            endLine: node.location.range.end.line + 1,
          },
          selection: {
            startLine: node.location.range.start.line + 1,
            startColumn: node.location.range.start.character + 1,
            endLine: node.location.range.end.line + 1,
            endColumn: node.location.range.end.character + 1,
          },
        });
      }
    };
    for (const node of raw) visit(node);
    return { symbols, source: "lsp" };
  };

  /**
   * grep fallback: rough-filter by "the name appears in the file" first, then run outline on the files that matched.
   *
   * Why not a "function definition" regex: a class method like `parseConfig() {` has no keyword,
   * so a regex inevitably misses it; whereas "the name appears somewhere in the file" is a lower bound that never misses.
   */
  const searchByFallback = async (
    query: string,
    limit: number,
    ctx: InboundRequestContext,
  ): Promise<SymbolHitDto[]> => {
    const needle = query.toLowerCase();
    const candidates = await vscode.workspace.findFiles("**/*", undefined, 2_000);
    const hits: SymbolHitDto[] = [];
    let scanned = 0;

    for (const uri of candidates) {
      if (hits.length >= limit || scanned >= FALLBACK_FILE_CAP) break;
      ctx.throwIfCancelled();
      if (isIgnored(uri.fsPath)) continue;   // ← node_modules / .gitignore do not count against the cap

      let text: string;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > FALLBACK_FILE_BYTES) continue;
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(needle)) continue;
      scanned += 1;

      const result = await outline(toWorkspaceRelative(uri.fsPath), ctx).catch(() => undefined);
      if (!result || result.source === "none") continue;
      for (const symbol of result.symbols) {
        if (!symbol.name.toLowerCase().includes(needle)) continue;
        hits.push({
          path: toWorkspaceRelative(uri.fsPath),
          name: symbol.name,
          kind: symbol.kind,
          container: symbol.container,
          range: symbol.range,
          selection: symbol.selection,
        });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  };

  /** Only accept file paths inside the workspace (multi-root workspaces and dependency indexes can bring out symbols from outside it) */
  const inWorkspace = (fsPath: string): boolean => {
    if (isIgnored(fsPath)) return false;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (roots.length === 0) return true;
    return roots.some((root) => isInside(root, fsPath));
  };

  return {
    async outline(params: SymbolsOutlineParams, ctx: InboundRequestContext): Promise<SymbolsOutlineResult> {
      ctx.throwIfCancelled();
      const result = await outline(params.path, ctx);
      logger.debug(`symbols.outline ${params.path} → ${result.symbols.length} 个符号`);
      return result;
    },

    /**
     * Find definitions by name across the whole workspace.
     *
     * Prefer `workspace/symbol` (the language service index, millisecond speed); if that is unavailable, fall back to
     * "rough-filter files by name + per-file outline filtering", and honestly mark it `source: "fallback"`
     * — so the caller knows the result may be incomplete.
     */
    async search(params: SymbolsSearchParams, ctx: InboundRequestContext): Promise<SymbolsSearchResult> {
      ctx.throwIfCancelled();
      const query = params.query.trim();
      if (!query) throw new Error("query 不能为空");
      const limit = clamp(params.maxResults ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

      let raw: vscode.SymbolInformation[] | undefined;
      try {
        raw = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          "vscode.executeWorkspaceSymbolProvider",
          query,
        );
      } catch (err) {
        logger.debug(`symbols.search 走 provider 失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (raw && raw.length > 0) {
        const usable = raw.filter(
          (s) => s.location?.uri?.scheme === "file" && inWorkspace(s.location.uri.fsPath),
        );
        const symbols = usable.slice(0, limit).map((s) => ({
          path: toWorkspaceRelative(s.location.uri.fsPath),
          name: s.name,
          kind: symbolKindName(s.kind),
          container: s.containerName || undefined,
          range: {
            startLine: s.location.range.start.line + 1,
            endLine: s.location.range.end.line + 1,
          },
          selection: {
            startLine: s.location.range.start.line + 1,
            startColumn: s.location.range.start.character + 1,
            endLine: s.location.range.end.line + 1,
            endColumn: s.location.range.end.character + 1,
          },
        }));
        logger.debug(`symbols.search "${query}" → ${symbols.length}/${raw.length} 个（lsp，已过滤工作区外）`);
        return { symbols, source: "lsp", truncated: usable.length > symbols.length };
      }

      const fallback = await searchByFallback(query, limit, ctx);
      logger.debug(`symbols.search "${query}" → ${fallback.length} 个（fallback）`);
      return {
        symbols: fallback,
        source: fallback.length > 0 ? "fallback" : "none",
        truncated: fallback.length >= limit,
      };
    },

    /**
     * All references at one position (**the line holding the symbol identifier**; prefer the `selection.startLine` returned by `outline`).
     */
    async references(params: SymbolsReferencesParams, ctx: InboundRequestContext): Promise<SymbolsReferencesResult> {
      ctx.throwIfCancelled();
      const uri = resolveTarget(params.path);
      const limit = clamp(params.maxResults ?? DEFAULT_REF_LIMIT, 1, MAX_REF_LIMIT);
      const line = Math.max(0, Math.trunc(params.line) - 1);
      const character = Math.max(0, Math.trunc(params.column ?? 1) - 1);

      const raw = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        "vscode.executeReferenceProvider",
        uri,
        new vscode.Position(line, character),
      );
      if (!raw || raw.length === 0) {
        logger.debug(`symbols.references ${params.path}:${params.line} → 无结果`);
        return { locations: [], truncated: false };
      }

      const seen = new Set<string>();
      const all: ReferenceHitDto[] = [];
      for (const loc of raw) {
        if (loc.uri.scheme !== "file") continue;
        const hit: ReferenceHitDto = {
          path: toWorkspaceRelative(loc.uri.fsPath),
          line: loc.range.start.line + 1,
          col: loc.range.start.character + 1,
        };
        const key = `${hit.path}:${hit.line}:${hit.col}`;
        if (seen.has(key)) continue;   // some providers return duplicate locations
        seen.add(key);
        all.push(hit);
      }
      all.sort((a, b) => (a.path === b.path ? a.line - b.line || a.col - b.col : a.path.localeCompare(b.path)));

      const locations = all.slice(0, limit);
      logger.debug(`symbols.references ${params.path}:${params.line} → ${locations.length} 处`);
      return { locations, truncated: all.length > locations.length };
    },
  };
}

function symbolKindName(kind: vscode.SymbolKind): string {
  const name = vscode.SymbolKind[kind];
  return typeof name === "string" ? name : String(kind);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
