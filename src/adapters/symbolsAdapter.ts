import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget, toWorkspaceRelative } from "../paths";
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

const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 500;
const DEFAULT_REF_LIMIT = 200;
const MAX_REF_LIMIT = 1_000;
/** 回退路径最多扫这么多文件（grep 命中的候选） */
const FALLBACK_FILE_CAP = 40;

/**
 * 符号服务：三个动作，对应三种问法。
 *
 *   outline    → 这个文件里有哪些函数/类（逐文件）
 *   search     → **哪个文件定义了叫 X 的东西**（全工作区，定义级）
 *   references → **X 在哪些地方被用到**（全工作区，引用级）
 *
 * 三者都不读文件内容，返回的只有「位置」；要看内容再用 `fs.read` / `read_symbol`。
 *
 * ⚠️ 返回类型有两种形态（取决于语言扩展注册的 provider）：
 *   - DocumentSymbol[]：有 range / children，可嵌套
 *   - SymbolInformation[]：扁平，只有 location
 * 必须同时兼容，否则一换语言就崩。
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
        });
        for (const child of node.children) visit(child, container ? `${container}.${node.name}` : node.name);
      } else {
        symbols.push({
          name: node.name,
          kind: symbolKindName(node.kind),
          container,
          range: {
            startLine: node.location.range.start.line + 1,
            endLine: node.location.range.end.line + 1,
          },
        });
      }
    };
    for (const node of raw) visit(node);
    return { symbols, source: "lsp" };
  };

  /** grep 回退：找文件里的函数/类定义行，再对命中的文件跑 outline */
  const searchByFallback = async (
    query: string,
    limit: number,
    ctx: InboundRequestContext,
  ): Promise<SymbolHitDto[]> => {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(?:function|def|class|interface|struct|fn|const|let|var)\\s+[\\w$]*${escaped}[\\w$]*`,
      "i",
    );
    const candidates = await vscode.workspace.findFiles("**/*", undefined, 2_000);
    const hits: SymbolHitDto[] = [];
    let scanned = 0;

    for (const uri of candidates) {
      if (hits.length >= limit || scanned >= FALLBACK_FILE_CAP) break;
      ctx.throwIfCancelled();
      let text: string;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 512 * 1024) continue;
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        continue;
      }
      if (!re.test(text)) continue;
      scanned += 1;

      const result = await outline(toWorkspaceRelative(uri.fsPath), ctx).catch(() => undefined);
      if (!result || result.source === "none") continue;
      for (const symbol of result.symbols) {
        if (!symbol.name.toLowerCase().includes(query.toLowerCase())) continue;
        hits.push({
          path: toWorkspaceRelative(uri.fsPath),
          name: symbol.name,
          kind: symbol.kind,
          container: symbol.container,
          range: symbol.range,
        });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  };

  return {
    async outline(params: SymbolsOutlineParams, ctx: InboundRequestContext): Promise<SymbolsOutlineResult> {
      ctx.throwIfCancelled();
      const result = await outline(params.path, ctx);
      logger.debug(`symbols.outline ${params.path} → ${result.symbols.length} 个符号`);
      return result;
    },

    /**
     * 全工作区按名字找定义。
     *
     * 首选 `workspace/symbol`（语言服务的索引，毫秒级）；拿不到就回退到
     * "grep 找候选文件 + 逐文件 outline 过滤"，并如实标注 `source: "fallback"`
     * ——调用方据此知道"结果可能不全"。
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
        const symbols = raw
          .filter((s) => s.location && typeof s.location.uri?.fsPath === "string")
          .slice(0, limit)
          .map((s) => ({
            path: toWorkspaceRelative(s.location.uri.fsPath),
            name: s.name,
            kind: symbolKindName(s.kind),
            container: s.containerName || undefined,
            range: {
              startLine: s.location.range.start.line + 1,
              endLine: s.location.range.end.line + 1,
            },
          }));
        logger.debug(`symbols.search "${query}" → ${symbols.length} 个（lsp）`);
        return { symbols, source: "lsp", truncated: raw.length > symbols.length };
      }

      const fallback = await searchByFallback(query, limit, ctx);
      logger.debug(`symbols.search "${query}" → ${fallback.length} 个（fallback）`);
      return {
        symbols: fallback,
        source: fallback.length > 0 ? "fallback" : "none",
        truncated: fallback.length >= limit,
      };
    },

    /** 某个位置（通常是符号名所在行）的所有引用 */
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

      const locations: ReferenceHitDto[] = raw.slice(0, limit).map((loc) => ({
        path: toWorkspaceRelative(loc.uri.fsPath),
        line: loc.range.start.line + 1,
        col: loc.range.start.character + 1,
      }));
      logger.debug(`symbols.references ${params.path}:${params.line} → ${locations.length} 处`);
      return { locations, truncated: raw.length > locations.length };
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
