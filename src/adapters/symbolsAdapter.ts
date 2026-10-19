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
/** 回退路径最多扫这么多文件（已被名字预筛过的候选） */
const FALLBACK_FILE_CAP = 40;
const FALLBACK_FILE_BYTES = 512 * 1024;

/**
 * 符号服务：三个动作，对应三种问法。
 *
 *   outline    → 这个文件里有哪些函数/类（逐文件）
 *   search     → **哪个文件定义了叫 X 的东西**（全工作区，定义级）
 *   references → **X 在哪些地方被用到**（全工作区，引用级）
 *
 * 三者都不读文件内容，返回的只有「位置」；要看内容再用 `fs.read` / `read_symbol`。
 *
 * 每个符号带**两个**范围：
 *   - `range`：整个符号（含前导注释/docstring）—— `read_symbol` 用它，读函数想带注释
 *   - `selection`：标识符本身 —— `references` 用它；用 `range` 的起始行常常落在注释里，
 *     参考提供者拿不到符号，会返回空结果（这是 v0.3 之前的一个隐性 bug）
 *
 * ⚠️ 返回类型有两种形态（取决于语言扩展注册的 provider）：
 *   - DocumentSymbol[]：有 range / selectionRange / children
 *   - SymbolInformation[]：扁平，只有 location + containerName
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
          selection: {
            startLine: node.selectionRange.start.line + 1,
            startColumn: node.selectionRange.start.character + 1,
            endLine: node.selectionRange.end.line + 1,
            endColumn: node.selectionRange.end.character + 1,
          },
        });
        for (const child of node.children) visit(child, container ? `${container}.${node.name}` : node.name);
      } else {
        // 扁平形态：provider 往往给了 containerName（属于哪个类），别丢
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
   * grep 回退：先按"名字出现在文件里"粗筛，再对命中的文件跑 outline。
   *
   * 为什么不用"函数定义"正则：`parseConfig() {` 这种类方法没有关键字，
   * 正则必然漏检；而"文件里出现过这个名字"是不会漏的下界。
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
      if (isIgnored(uri.fsPath)) continue;   // ← node_modules / .gitignore 不占名额

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

  /** 工作区内的 file 路径才接受（多根工作区、依赖索引都可能带出工作区外的符号） */
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
     * 全工作区按名字找定义。
     *
     * 首选 `workspace/symbol`（语言服务的索引，毫秒级）；拿不到就回退到
     * "按名字粗筛文件 + 逐文件 outline 过滤"，并如实标注 `source: "fallback"`
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
     * 某个位置（**符号标识符所在行**，优先用 `outline` 返回的 `selection.startLine`）的所有引用。
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
        if (seen.has(key)) continue;   // 某些 provider 会返回重复位置
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
