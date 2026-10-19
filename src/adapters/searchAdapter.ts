import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { toWorkspaceRelative } from "../paths";
import type { GrepHit, SearchGrepParams, SearchGrepResult } from "../protocol";
import { isIgnored } from "../workspaceIgnore";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_SCANNED = 4_000;

/**
 * 代码检索（只在壳内做 I/O，匹配逻辑很薄）。
 *
 * ❗ 注意：`workspace.findTextInFiles` 至今仍是 **proposed API**（stable
 * @types/vscode 里没有），所以这里不能用它。当前实现是
 * `findFiles` + 逐文件读 + 正则匹配：
 *   - 优点：只用公开 API，行为可预测
 *   - 缺点：大仓库慢（有 4000 文件 / 256KB 上限兜底）
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

      const re = params.regex ? safeRegex(query) : new RegExp(escapeRegExp(query), "i");
      const files = await vscode.workspace.findFiles(
        params.glob && params.glob.length > 0 ? params.glob : "**/*",
        undefined,
        MAX_FILES_SCANNED,
      );

      const hits: GrepHit[] = [];
      let truncated = files.length >= MAX_FILES_SCANNED;

      for (const uri of files) {
        ctx.throwIfCancelled();
        if (hits.length >= limit) {
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

        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? "";
          const match = re.exec(line);
          if (!match) continue;
          hits.push({
            path: toWorkspaceRelative(uri.fsPath),
            line: i + 1,
            col: (match.index ?? 0) + 1,
            text: contextLines > 0 ? snippet(lines, i, contextLines) : line.trim(),
          });
          if (hits.length >= limit) {
            truncated = true;
            break;
          }
        }
      }

      ctx.throwIfCancelled();
      logger.debug(`search.grep "${query}" → ${hits.length} 条（扫描 ${files.length} 个文件）`);
      return { hits, truncated };
    },
  };
}

function snippet(lines: string[], index: number, context: number): string {
  const from = Math.max(0, index - context);
  const to = Math.min(lines.length - 1, index + context);
  return lines
    .slice(from, to + 1)
    .map((line, offset) => {
      const lineNo = from + offset + 1;
      const marker = lineNo === index + 1 ? "▶" : " ";
      return `${marker}${String(lineNo).padStart(5)} ${line}`;
    })
    .join("\n");
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(`非法正则：${err instanceof Error ? err.message : String(err)}`);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
