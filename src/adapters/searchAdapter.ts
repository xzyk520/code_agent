import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { toWorkspaceRelative } from "../paths";
import type { GrepFileHit, GrepHit, SearchGrepParams, SearchGrepResult } from "../protocol";
import { isIgnored } from "../workspaceIgnore";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_SCANNED = 4_000;
/** Regex length limit: anything longer is almost certainly not a human-written search pattern */
const MAX_PATTERN_LENGTH = 300;
/** Max length of a line that takes part in matching (beyond it only the prefix is matched, so huge lines don't slow it down) */
const MAX_LINE_FOR_MATCH = 2_000;
/** Max matches counted per line (keeps patterns like `a` from blowing up the count on long lines) */
const MAX_MATCHES_PER_LINE = 50;
/** Max matches counted per file; beyond that the file is flagged capped */
const MAX_FILE_MATCHES = 1_000;
/** Overall scan time budget: once exceeded, return with truncated instead of choking the extension host */
const MAX_SCAN_MS = 5_000;

/**
 * Code search (only I/O happens in the shell; the matching logic is thin).
 *
 * ❗ Note: `workspace.findTextInFiles` is still a **proposed API** (it is not in
 * stable @types/vscode), so it cannot be used here. The current implementation is
 * `findFiles` + per-file read + regex matching:
 *   - Pros: public APIs only, predictable behavior
 *   - Cons: slow on large repos (backed by three limits: 4000 files / 256KB / 5s)
 * Future optimization (TODO): if `rg` is detected on the system, spawn `rg --json`; otherwise fall back to this implementation.
 */
export function createSearchAdapter(logger: Logger) {
  return {
    async grep(params: SearchGrepParams, ctx: InboundRequestContext): Promise<SearchGrepResult> {
      ctx.throwIfCancelled();
      const query = params.query;
      if (!query) throw new Error("query 不能为空");

      const limit = Math.min(params.maxResults ?? 200, 2_000);
      const contextLines = Math.max(0, Math.min(params.contextLines ?? 0, 5));
      // Recall mode: report only which files matched and how many times, without line text
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
        // Shared ignore rules (noise directories + .gitignore), consistent with fs.list / diagnostics
        if (isIgnored(uri.fsPath)) continue;

        let text: string;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_FILE_BYTES) continue;
          const raw = await vscode.workspace.fs.readFile(uri);
          const buf = Buffer.from(raw);
          if (buf.subarray(0, 8192).includes(0)) continue; // binary
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
          // Very long lines match only the prefix: regex cost grows exponentially with length, so a cap is mandatory here
          const line = full.length > MAX_LINE_FOR_MATCH ? full.slice(0, MAX_LINE_FOR_MATCH) : full;
          // Recall mode accumulates per file (capped at MAX_FILE_MATCHES); hit mode throttles per line
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

          // Uniform shape: text is always the bare line; context and match count travel in separate fields
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
      // Sorting makes the result reproducible (findFiles order depends on the filesystem)
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
 * Build the regex, and block patterns that "obviously blow up".
 *
 * Why this is needed: JS regexes cannot be interrupted (there is no timeout API); a
 * single `(a+)+$` can freeze the extension host, and the model is entirely capable of
 * generating such a pattern (it has no idea of the execution cost).
 * Three guards here: length limit, nested-quantifier heuristic, per-line length limit.
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

/** Crude but effective heuristic: things like `(...+)+`, `(...*)*`, `++`, `+*` */
export function looksCatastrophic(pattern: string): boolean {
  if (/(\([^)]*[+*][^)]*\)\s*[+*])/.test(pattern)) return true; // (…+)+
  if (/(\[[^\]]*\]\s*[+*])\s*[+*]/.test(pattern)) return true; // […]+ +
  if (/[+*]\s*[+*]/.test(pattern)) return true; // ++ / +* / *+
  return false;
}

/** Count matches in one line and the column of the first match (1-based). Zero-width matches must advance lastIndex manually, or this loops forever. */
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
    if (match[0].length === 0) re.lastIndex += 1; // zero-width match: avoid spinning in place
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
