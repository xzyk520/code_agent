import * as fs from "node:fs";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget, toWorkspaceRelative } from "../paths";
import type { FsListParams, FsListResult, FsReadParams, FsReadResult } from "../protocol";
import { isIgnored } from "../workspaceIgnore";

/** 整文件读取上限：超过它就不再"整份读进内存"，改走流式按行读 */
const MAX_INLINE_BYTES = 512 * 1024;
/** 单次**返回给模型**的内容上限：与文件多大无关，只看这次读了多少 */
const MAX_RETURN_BYTES = 256 * 1024;
const MAX_RETURN_LINES = 2_000;
/** 二进制探测：只读开头这么多字节找 NUL */
const SNIFF_BYTES = 8 * 1024;
const DEFAULT_LIST_LIMIT = 5_000;
/** 列表先多取再过滤，避免"前 N 个都被忽略 → 返回空" */
const LIST_OVERFETCH = 4;
const LIST_HARD_CAP = 20_000;

/**
 * 文件读取与列举。
 *
 * 两个关键事实（都写进了 README §8.1）：
 *   1. `workspace.findFiles` **不读 .gitignore**，只认 files.exclude / search.exclude
 *   2. `exclude` 传 undefined 会用默认排除，传 null 则完全不过滤
 *
 * 读取策略（v0.4 起）：
 *   - **按"这次要返回多少"限流，而不是按"文件多大"拒绝**
 *   - 小文件：优先用编辑器文档（能看到未保存内容 + 拿到 version）
 *   - 大文件：流式按行读，只读到 `endLine` 为止，内存占用与文件大小无关
 *   - 无论哪条路径，单次返回都受 `MAX_RETURN_BYTES` / `MAX_RETURN_LINES` 约束
 */
export function createFsAdapter(logger: Logger) {
  return {
    async read(params: FsReadParams, ctx: InboundRequestContext): Promise<FsReadResult> {
      ctx.throwIfCancelled();
      const uri = resolveTarget(params.path);
      const rel = toWorkspaceRelative(uri.fsPath);

      // ① 已经在编辑器里打开（可能未保存）→ 直接用文档，拿到最新内容与 version
      const openDoc = vscode.workspace.textDocuments?.find((d) => d.uri.fsPath === uri.fsPath);
      if (openDoc) {
        const result = readFromDocument(openDoc, params);
        logger.debug(`fs.read ${rel} L${result.startLine}-L${result.endLine}（编辑器文档）`);
        return result;
      }

      // ② 没打开：先看大小，决定"整份打开"还是"流式按行读"
      const stat = await vscode.workspace.fs.stat(uri);
      await assertNotBinary(uri, rel);

      if (stat.size <= MAX_INLINE_BYTES) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const result = readFromDocument(doc, params);
          logger.debug(`fs.read ${rel} L${result.startLine}-L${result.endLine}`);
          return result;
        } catch {
          // 打开失败（非文本文件等）→ 落到流式读
        }
      }

      const result = await readByStreaming(uri, params);
      logger.debug(
        `fs.read ${rel} L${result.startLine}-L${result.endLine}（流式，${result.text.length} 字符${result.truncated ? "，已截断" : ""}）`,
      );
      return result;
    },

    async list(params: FsListParams, ctx: InboundRequestContext): Promise<FsListResult> {
      ctx.throwIfCancelled();
      const glob = params.glob && params.glob.length > 0 ? params.glob : "**/*";
      const limit = Math.min(params.maxResults ?? DEFAULT_LIST_LIMIT, LIST_HARD_CAP);
      // 先多取：过滤（node_modules / .gitignore）之后可能砍掉很多，不能一开始就截断
      const fetch = Math.min(limit * LIST_OVERFETCH, LIST_HARD_CAP);

      // `exclude: null` 表示"完全不过滤"，要原样透传；undefined 才用默认排除
      const found = await vscode.workspace.findFiles(glob, params.exclude === null ? null : (params.exclude ?? undefined), fetch);

      const paths: string[] = [];
      for (const uri of found) {
        ctx.throwIfCancelled();
        if (isIgnored(uri.fsPath)) continue;
        paths.push(toWorkspaceRelative(uri.fsPath));
        if (paths.length >= limit) break;
      }

      // 取回的数量达到抓取上限，说明可能还有更多
      const truncated = found.length >= fetch || paths.length >= limit;
      logger.debug(`fs.list ${glob} → ${paths.length} 个文件${truncated ? "（可能被截断）" : ""}`);
      return { paths, truncated };
    },
  };
}

/** 从已打开的文档里取行范围 */
function readFromDocument(doc: vscode.TextDocument, params: FsReadParams): FsReadResult {
  const totalLines = doc.lineCount;
  const { startLine, endLine, truncated } = planRange(params, totalLines);
  const text = doc.getText(
    new vscode.Range(startLine - 1, 0, endLine - 1, doc.lineAt(endLine - 1).text.length),
  );
  return capResult({ text, version: doc.version, totalLines, startLine, endLine, truncated }, totalLines);
}

/**
 * 大文件：流式按行读，只读到 `endLine`（或字节上限）为止。
 *
 * 关键：**内存占用取决于读了多少行，而不是文件多大**。
 * 一个 500MB 的日志，只读第 1000–1010 行也只占十几 KB。
 */
async function readByStreaming(uri: vscode.Uri, params: FsReadParams): Promise<FsReadResult> {
  const startLine = Math.max(1, Math.trunc(params.startLine ?? 1));
  const requestedEnd = params.endLine === undefined ? Number.POSITIVE_INFINITY : Math.max(startLine, Math.trunc(params.endLine));

  const stream = fs.createReadStream(uri.fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const collected: string[] = [];
  let lineNo = 0;
  let bytes = 0;
  let endLine = startLine - 1;
  let truncated = false;
  let reachedEof = false;

  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < startLine) continue;
      if (lineNo > requestedEnd) {
        // 请求范围读完了，但文件还有内容 —— 不代表截断
        reachedEof = false;
        break;
      }
      if (collected.length >= MAX_RETURN_LINES || bytes + line.length > MAX_RETURN_BYTES) {
        truncated = true;
        break;
      }
      collected.push(line);
      bytes += line.length + 1;
      endLine = lineNo;
      reachedEof = true;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    text: collected.join("\n"),
    totalLines: reachedEof ? lineNo : undefined,
    startLine,
    endLine: Math.max(endLine, startLine),
    truncated,
  };
}

/** 二进制探测：开头出现 NUL 就当成二进制，避免把乱码塞进上下文 */
async function assertNotBinary(uri: vscode.Uri, rel: string): Promise<void> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(uri.fsPath, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fd.read(buffer, 0, SNIFF_BYTES, 0);
    if (buffer.subarray(0, bytesRead).includes(0)) {
      throw new Error(`看起来是二进制文件，拒绝读取：${rel}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("看起来是二进制文件")) throw err;
    // 打不开就交给后面的读取逻辑报错
  } finally {
    await fd?.close().catch(() => undefined);
  }
}

/** 计算合法行范围，并施加"单次最多多少行"的限制 */
function planRange(params: FsReadParams, totalLines: number): { startLine: number; endLine: number; truncated: boolean } {
  const maxLine = Math.max(totalLines, 1);
  const startLine = clamp(params.startLine ?? 1, 1, maxLine);
  const requestedEnd = clamp(params.endLine ?? maxLine, startLine, maxLine);
  const cappedEnd = Math.min(requestedEnd, startLine + MAX_RETURN_LINES - 1);
  return { startLine, endLine: cappedEnd, truncated: cappedEnd < requestedEnd };
}

/** 内容超长时按字节截断（行范围是对的，但单行可能极长，例如压缩后的 JS） */
function capResult(result: FsReadResult, totalLines: number): FsReadResult {
  if (Buffer.byteLength(result.text, "utf8") <= MAX_RETURN_BYTES) return result;
  let text = result.text;
  while (Buffer.byteLength(text, "utf8") > MAX_RETURN_BYTES) {
    text = text.slice(0, Math.floor(text.length * 0.9));
  }
  return { ...result, text, totalLines, truncated: true };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
