import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { toWorkspaceRelative } from "../paths";
import type { GrepFileHit, GrepHit, SearchGrepParams, SearchGrepResult } from "../protocol";
import { isIgnored } from "../workspaceIgnore";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_SCANNED = 4_000;
/** 正则长度上限：超过基本可以断定不是人类写的搜索模式 */
const MAX_PATTERN_LENGTH = 300;
/** 单行参与匹配的最大长度（超出只匹配前缀，避免超长行拖慢） */
const MAX_LINE_FOR_MATCH = 2_000;
/** 一行最多统计多少个匹配（防止 `a` 这类模式在长行上刷爆计数） */
const MAX_MATCHES_PER_LINE = 50;
/** 单文件最多统计多少个匹配，超过标记 capped */
const MAX_FILE_MATCHES = 1_000;
/** 整体扫描时间预算：超过就带着 truncated 返回，别把扩展宿主拖死 */
const MAX_SCAN_MS = 5_000;

/**
 * 代码检索（只在壳内做 I/O，匹配逻辑很薄）。
 *
 * ❗ 注意：`workspace.findTextInFiles` 至今仍是 **proposed API**（stable
 * @types/vscode 里没有），所以这里不能用它。当前实现是
 * `findFiles` + 逐文件读 + 正则匹配：
 *   - 优点：只用公开 API，行为可预测
 *   - 缺点：大仓库慢（有 4000 文件 / 256KB / 5s 三重上限兜底）
 * 后续优化（TODO）：探测到系统里有 `rg` 就 spawn `rg --json`，否则回落到本实现。
 */
export function createSearchAdapter(logger: Logger) {
  return {
    async grep(params: SearchGrepParams, ctx: InboundRequestContext): Promise<SearchGrepResult> {
      ctx.throwIfCancelled();
      const query = params.query;
      if (!query) throw new Error("query 不能为空");

      const limit = Math.min(params.maxResults ?? 200, 2_000);
      const contextLines = Math.max(0, Math.min(params.contextLines ?? 0, 5));
      // 召回模式：只回「哪些文件命中、各几次」，不返回行文本
      const filesOnly = params.filesOnly === true;

      const re = buildRegex(query, params.regex === true, params.caseSensitive === true);
      const files = await vscode.workspace.findFiles(
        params.glob && params.glob.length > 0 ? params.glob : "**/*",
        params.exclude === null ? null : (params.exclude ?? undefined),
        MAX_FILES_SCANNED,
      );

      const hits: GrepHit[] = [];
      const fileHits: GrepFileHit[] = [];
      let truncated = files.length >= MAX_FILES_SCANNED;
      const startedAt = Date.now();

      for (const uri of files) {
        ctx.throwIfCancelled();
        if (Date.now() - startedAt > MAX_SCAN_MS) {
          truncated = true;
          logger.warn(`search.grep 超过 ${MAX_SCAN_MS}ms 预算，提前结束（扫描 ${files.length} 个文件）`);
          break;
        }
        if (!filesOnly && hits.length >= limit) {
          truncated = true;
          break;
        }
        if (filesOnly && fileHits.length >= limit) {
          truncated = true;
          break;
        }
        // 统一的忽略规则（噪声目录 + .gitignore），与 fs.list / diagnostics 一致
        if (isIgnored(uri.fsPath)) continue;

        let text: string;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_FILE_BYTES) continue;
          const raw = await vscode.workspace.fs.readFile(uri);
          const buf = Buffer.from(raw);
          if (buf.subarray(0, 8192).includes(0)) continue; // 二进制
          text = buf.toString("utf8");
        } catch {
          continue;
        }

        const rel = toWorkspaceRelative(uri.fsPath);
        const lines = text.split(/\r?\n/);
        let perFile = 0;
        let cappedFile = false;

        for (let i = 0; i < lines.length; i += 1) {
          const full = lines[i] ?? "";
          // 超长行只匹配前缀：正则的代价随长度指数上升，这里必须设闸
          const line = full.length > MAX_LINE_FOR_MATCH ? full.slice(0, MAX_LINE_FOR_MATCH) : full;
          // 召回模式按文件累计（上限 MAX_FILE_MATCHES）；命中模式按行限流
          const counts = countMatches(line, re, filesOnly ? MAX_FILE_MATCHES : MAX_MATCHES_PER_LINE);
          if (counts.firstCol === 0) continue;
          if (counts.capped) cappedFile = true;

          perFile += counts.total;
          if (filesOnly) {
            if (perFile >= MAX_FILE_MATCHES) {
              cappedFile = true;
              break;
            }
            continue;
          }

          // 统一格式：text 永远是「裸行」，上下文与匹配数走独立字段
          hits.push({
            path: rel,
            line: i + 1,
            col: counts.firstCol,
            text: full.trimEnd(),
            count: counts.total > 1 ? counts.total : undefined,
            context: contextLines > 0 ? snippet(lines, i, contextLines) : undefined,
          });
          if (hits.length >= limit) {
            truncated = true;
            break;
          }
        }

        if (filesOnly && perFile > 0) {
          fileHits.push({
            path: rel,
            matches: Math.min(perFile, MAX_FILE_MATCHES),
            capped: cappedFile ? true : undefined,
          });
        }
      }

      ctx.throwIfCancelled();
      // 排序保证可复现（findFiles 的顺序依赖文件系统）
      hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
      fileHits.sort((a, b) => a.path.localeCompare(b.path));

      if (filesOnly) {
        logger.debug(`search.grep "${query}"（filesOnly）→ ${fileHits.length} 个文件（扫描 ${files.length} 个）`);
        return { hits: [], files: fileHits, truncated };
      }
      logger.debug(`search.grep "${query}" → ${hits.length} 条（扫描 ${files.length} 个文件）`);
      return { hits, truncated };
    },
  };
}

/**
 * 构造正则，并挡住"明显会爆炸"的模式。
 *
 * 为什么需要：JS 正则不可中断（没有超时 API），一个 `(a+)+$` 就能把扩展宿主卡死，
 * 而模型是完全可能生成这种模式的（它不知道执行成本）。
 * 这里做三道防护：长度上限、嵌套量词启发式、单行长度上限。
 */
function buildRegex(query: string, isRegex: boolean, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? "g" : "gi";
  if (!isRegex) return new RegExp(escapeRegExp(query), flags);

  if (query.length > MAX_PATTERN_LENGTH) {
    throw new Error(`正则过长（${query.length} > ${MAX_PATTERN_LENGTH} 字符），请用更短的模式或改用关键词搜索`);
  }
  if (looksCatastrophic(query)) {
    throw new Error(
      "这个正则可能引发灾难性回溯（嵌套量词，如 (a+)+），已拒绝执行；请改用更简单的模式",
    );
  }
  try {
    return new RegExp(query, flags);
  } catch (err) {
    throw new Error(`非法正则：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 粗糙但有效的启发式：`(...+)+`、`(...*)*`、`++`、`+*` 之类 */
export function looksCatastrophic(pattern: string): boolean {
  if (/(\([^)]*[+*][^)]*\)\s*[+*])/.test(pattern)) return true; // (…+)+
  if (/(\[[^\]]*\]\s*[+*])\s*[+*]/.test(pattern)) return true; // […]+ +
  if (/[+*]\s*[+*]/.test(pattern)) return true; // ++ / +* / *+
  return false;
}

/** 统计一行里的匹配数与第一个匹配的列（1-based）。零宽匹配要手动推进 lastIndex，否则死循环。 */
function countMatches(line: string, re: RegExp, perLineLimit: number): { total: number; firstCol: number; capped: boolean } {
  re.lastIndex = 0;
  let total = 0;
  let firstCol = 0;
  let capped = false;
  let match: RegExpExecArray | null;

  while ((match = re.exec(line)) !== null) {
    if (total === 0) firstCol = match.index + 1;
    total += 1;
    if (total >= perLineLimit) {
      capped = true;
      break;
    }
    if (match[0].length === 0) re.lastIndex += 1; // 零宽匹配：避免原地打转
    if (re.lastIndex > line.length) break;
  }
  re.lastIndex = 0;
  return { total, firstCol, capped };
}

function snippet(lines: string[], index: number, context: number): string {
  const from = Math.max(0, index - context);
  const to = Math.min(lines.length - 1, index + context);
  const width = String(to + 1).length;
  return lines
    .slice(from, to + 1)
    .map((line, offset) => {
      const lineNo = from + offset + 1;
      const marker = lineNo === index + 1 ? "▶" : " ";
      return `${marker}${String(lineNo).padStart(width)} ${line}`;
    })
    .join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
