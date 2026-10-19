import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget, toWorkspaceRelative } from "../paths";
import type { FsListParams, FsListResult, FsReadParams, FsReadResult } from "../protocol";
import { isIgnored } from "../workspaceIgnore";

const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_LIST_LIMIT = 5000;

/**
 * 文件读取与列举。
 *
 * 两个关键事实（都写进了 README §8.1）：
 *   1. `workspace.findFiles` **不读 .gitignore**，只认 files.exclude / search.exclude
 *   2. `exclude` 传 undefined 会用默认排除，传 null 则完全不过滤
 */
export function createFsAdapter(logger: Logger) {
  return {
    async read(params: FsReadParams, ctx: InboundRequestContext): Promise<FsReadResult> {
      ctx.throwIfCancelled();
      const uri = resolveTarget(params.path);

      // 优先用编辑器里的文档：用户改了没保存，内核也必须看到最新内容
      let doc: vscode.TextDocument | undefined;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        doc = undefined;
      }

      if (doc) {
        const totalLines = doc.lineCount;
        const start = clamp(params.startLine ?? 1, 1, Math.max(totalLines, 1));
        const end = clamp(params.endLine ?? totalLines, start, Math.max(totalLines, 1));
        const text = doc.getText(new vscode.Range(start - 1, 0, end - 1, doc.lineAt(end - 1).text.length));
        return { text, version: doc.version, totalLines };
      }

      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`文件过大（${Math.round(stat.size / 1024)}KB > 512KB），请改用 read_file 的分段参数`);
      }
      const raw = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(raw).toString("utf8");
      const lines = text.split("\n");
      const start = clamp(params.startLine ?? 1, 1, Math.max(lines.length, 1));
      const end = clamp(params.endLine ?? lines.length, start, Math.max(lines.length, 1));
      logger.debug(`fs.read ${toWorkspaceRelative(uri.fsPath)} L${start}-L${end}`);
      return { text: lines.slice(start - 1, end).join("\n"), version: 0, totalLines: lines.length };
    },

    async list(params: FsListParams, ctx: InboundRequestContext): Promise<FsListResult> {
      ctx.throwIfCancelled();
      const glob = params.glob && params.glob.length > 0 ? params.glob : "**/*";
      const limit = Math.min(params.maxResults ?? DEFAULT_LIST_LIMIT, 20_000);

      const found = await vscode.workspace.findFiles(glob, params.exclude ?? undefined, limit);
      const paths: string[] = [];
      for (const uri of found) {
        ctx.throwIfCancelled();
        // 统一的忽略规则（噪声目录 + .gitignore），与 search / diagnostics 一致
        if (isIgnored(uri.fsPath)) continue;
        paths.push(toWorkspaceRelative(uri.fsPath));
        if (paths.length >= limit) break;
      }
      logger.debug(`fs.list ${glob} → ${paths.length} 个文件`);
      return { paths };
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
