import * as fs from "node:fs";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget, toWorkspaceRelative } from "../paths";
import type { FsListParams, FsListResult, FsReadParams, FsReadResult } from "../protocol";
import { isIgnored } from "../workspaceIgnore";

/** Whole-file read limit: beyond it, stop reading the whole thing into memory and stream line by line instead */
const MAX_INLINE_BYTES = 512 * 1024;
/** Cap on content **returned to the model** per call: independent of file size, only of how much is read this time */
const MAX_RETURN_BYTES = 256 * 1024;
const MAX_RETURN_LINES = 2_000;
/** Binary sniffing: read only this many bytes at the start in search of a NUL */
const SNIFF_BYTES = 8 * 1024;
const DEFAULT_LIST_LIMIT = 5_000;
/** Listing over-fetches before filtering, to avoid "the first N were all ignored → empty result" */
const LIST_OVERFETCH = 4;
const LIST_HARD_CAP = 20_000;

/**
 * File reading and listing.
 *
 * Two key facts (both documented in README §8.1):
 *   1. `workspace.findFiles` **does not read .gitignore**; it only honors files.exclude / search.exclude
 *   2. `exclude` set to undefined applies the default excludes, while null filters nothing at all
 *
 * Read strategy (since v0.4):
 *   - **Throttle by "how much to return this time", not by "how big the file is"**
 *   - Small files: prefer the editor document (sees unsaved content + gets a version)
 *   - Large files: stream line by line, reading only up to `endLine`, so memory use is independent of file size
 *   - Either path, a single return is bounded by `MAX_RETURN_BYTES` / `MAX_RETURN_LINES`
 */
export function createFsAdapter(logger: Logger) {
  return {
    async read(params: FsReadParams, ctx: InboundRequestContext): Promise<FsReadResult> {
      ctx.throwIfCancelled();
      const uri = resolveTarget(params.path);
      const rel = toWorkspaceRelative(uri.fsPath);

      // 1) Already open in an editor (possibly unsaved) → use the document directly for the latest content and version
      const openDoc = vscode.workspace.textDocuments?.find((d) => d.uri.fsPath === uri.fsPath);
      if (openDoc) {
        const result = readFromDocument(openDoc, params);
        logger.debug(`fs.read ${rel} L${result.startLine}-L${result.endLine} (editor document)`);
        return result;
      }

      // 2) Not open: check the size first and choose between "open the whole file" and "stream line by line"
      const stat = await vscode.workspace.fs.stat(uri);
      await assertNotBinary(uri, rel);

      if (stat.size <= MAX_INLINE_BYTES) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const result = readFromDocument(doc, params);
          logger.debug(`fs.read ${rel} L${result.startLine}-L${result.endLine}`);
          return result;
        } catch {
          // Open failed (non-text file, etc.) → fall back to the streaming read
        }
      }

      const result = await readByStreaming(uri, params);
      logger.debug(
        `fs.read ${rel} L${result.startLine}-L${result.endLine} (streamed, ${result.text.length} chars${result.truncated ? ", truncated" : ""})`,
      );
      return result;
    },

    async list(params: FsListParams, ctx: InboundRequestContext): Promise<FsListResult> {
      ctx.throwIfCancelled();
      const glob = params.glob && params.glob.length > 0 ? params.glob : "**/*";
      const limit = Math.min(params.maxResults ?? DEFAULT_LIST_LIMIT, LIST_HARD_CAP);
      // Over-fetch first: filtering (node_modules / .gitignore) can drop a lot, so don't truncate upfront
      const fetch = Math.min(limit * LIST_OVERFETCH, LIST_HARD_CAP);

      // `exclude: null` means "no filtering at all" and must be passed through as is; only undefined uses the default excludes
      const found = await vscode.workspace.findFiles(glob, params.exclude === null ? null : (params.exclude ?? undefined), fetch);

      const paths: string[] = [];
      for (const uri of found) {
        ctx.throwIfCancelled();
        if (isIgnored(uri.fsPath)) continue;
        paths.push(toWorkspaceRelative(uri.fsPath));
        if (paths.length >= limit) break;
      }

      // Reaching the fetch cap means there may be more
      const truncated = found.length >= fetch || paths.length >= limit;
      logger.debug(`fs.list ${glob} → ${paths.length} files${truncated ? " (possibly truncated)" : ""}`);
      return { paths, truncated };
    },
  };
}

/** Take a line range from an already open document */
function readFromDocument(doc: vscode.TextDocument, params: FsReadParams): FsReadResult {
  const totalLines = doc.lineCount;
  const { startLine, endLine, truncated } = planRange(params, totalLines);
  const text = doc.getText(
    new vscode.Range(startLine - 1, 0, endLine - 1, doc.lineAt(endLine - 1).text.length),
  );
  return capResult({ text, version: doc.version, totalLines, startLine, endLine, truncated }, totalLines);
}

/**
 * Large files: stream line by line, reading only up to `endLine` (or the byte cap).
 *
 * Key point: **memory use depends on how many lines are read, not on how big the file is**.
 * For a 500MB log, reading just lines 1000–1010 still costs only a dozen KB.
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
        // Requested range is done, but the file still has content — that is not truncation
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

/** Binary sniffing: a NUL at the start means binary, keeping garbage out of the context */
async function assertNotBinary(uri: vscode.Uri, rel: string): Promise<void> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(uri.fsPath, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fd.read(buffer, 0, SNIFF_BYTES, 0);
    if (buffer.subarray(0, bytesRead).includes(0)) {
      throw new Error(`Refusing to read binary file: ${rel}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Refusing to read binary file")) throw err;
    // If it cannot be opened, let the read logic below report the error
  } finally {
    await fd?.close().catch(() => undefined);
  }
}

/** Compute a valid line range and apply the "max lines per call" cap */
function planRange(params: FsReadParams, totalLines: number): { startLine: number; endLine: number; truncated: boolean } {
  const maxLine = Math.max(totalLines, 1);
  const startLine = clamp(params.startLine ?? 1, 1, maxLine);
  const requestedEnd = clamp(params.endLine ?? maxLine, startLine, maxLine);
  const cappedEnd = Math.min(requestedEnd, startLine + MAX_RETURN_LINES - 1);
  return { startLine, endLine: cappedEnd, truncated: cappedEnd < requestedEnd };
}

/** Truncate by bytes when the content is too long (the line range is right, but a single line can be enormous, e.g. minified JS) */
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
