import * as path from "node:path";
import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget } from "../paths";
import type { EditApplyParams, EditApplyResult } from "../protocol";

/** Per-write cap: when the model goes off the rails and emits several MB, refuse rather than blow up the undo stack */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * The only write channel (README §10.2).
 *
 * Hard rules:
 *   1. Use WorkspaceEdit rather than TextEditor.edit (independent of editor visibility, lands in the undo stack)
 *   2. One applyEdit = one undo unit
 *   3. expectedVersion mismatch → refuse the write and report conflict (never overwrite the user's edit)
 *   4. Compute first, write second: the core computes newText; no patch parsing or error tolerance here
 *   5. Newlines follow the target file (a CRLF file is never written as LF, or git shows the entire file as changed)
 *   6. New files go through createFile + insert (replace does nothing for a missing file), and parent dirs are created
 *   7. Refuse delete for files with unsaved changes (otherwise the user's edits are silently lost)
 */
export function createEditAdapter(logger: Logger) {
  return {
    async apply(params: EditApplyParams, ctx: InboundRequestContext): Promise<EditApplyResult> {
      ctx.throwIfCancelled();
      const uri = resolveTarget(params.path);
      const op = params.op ?? "write";

      if (op === "write") {
        const bytes = Buffer.byteLength(params.newText, "utf8");
        if (bytes > MAX_TEXT_BYTES) {
          return {
            applied: false,
            message: `内容过大（${Math.round(bytes / 1024)} KB，上限 ${MAX_TEXT_BYTES / 1024 / 1024} MB）`,
          };
        }
      }

      // Open once: used both for the version comparison and to decide between "modify existing file" and "create new file"
      const doc = await openIfExists(uri);

      if (doc && typeof params.expectedVersion === "number" && params.expectedVersion !== doc.version) {
        logger.warn(`edit.apply 版本冲突: ${params.path} 期望 v${params.expectedVersion} 实际 v${doc.version}`);
        return {
          applied: false,
          conflict: true,
          version: doc.version,
          message: `文件已被修改（期望 v${params.expectedVersion}，实际 v${doc.version}），请重新读取后再改`,
        };
      }

      if (!doc && (op === "delete" || typeof params.expectedVersion === "number")) {
        // Deleting a file that does not exist, or expecting a version yet finding no file — both mean stale caller state
        return { applied: false, message: `文件不存在：${params.path}` };
      }

      const edit = new vscode.WorkspaceEdit();

      if (op === "delete") {
        if (doc?.isDirty) {
          return { applied: false, version: doc.version, message: "文件有未保存的修改，已拒绝删除（请先保存或撤销）" };
        }
        edit.deleteFile(uri, { ignoreIfNotExists: false, recursive: false });
        const deleted = await vscode.workspace.applyEdit(edit);
        if (!deleted) {
          return { applied: false, message: "WorkspaceEdit 被拒绝（文件可能被锁定）" };
        }
        logger.info(`edit.apply delete ${params.path}${params.reason ? ` (${params.reason})` : ""}`);
        // The file is gone, so a version is meaningless — do not return a stale value
        return { applied: true };
      }

      const text = adaptEol(params.newText, doc?.eol);
      if (doc) {
        const end = doc.positionAt(doc.getText().length);
        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), text);
      } else {
        await ensureParentDir(uri);
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), text);
      }

      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        return {
          applied: false,
          version: doc?.version,
          message: "WorkspaceEdit 被拒绝（文件可能被锁定或已被外部修改）",
        };
      }

      const reopened = await vscode.workspace.openTextDocument(uri);
      logger.info(`edit.apply ${doc ? "write" : "create"} ${params.path}${params.reason ? ` (${params.reason})` : ""}`);
      return { applied: true, version: reopened.version };
    },
  };
}

/** Open the document; return undefined when it is missing (or not a text file) instead of throwing */
async function openIfExists(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

/**
 * Normalize newlines to the target file's style.
 *
 * Without this: a CRLF file rewritten entirely as LF makes `git diff` show "the whole file
 * changed", and the user's .gitattributes / editorconfig rules are all bypassed.
 */
export function adaptEol(text: string, eol?: vscode.EndOfLine): string {
  const lf = text.replace(/\r\n/g, "\n");
  if (eol === undefined) {
    // New file: follow `files.eol`; when auto, use the platform convention
    const configured = vscode.workspace.getConfiguration("files").get<string>("eol");
    const crlf = configured === "\r\n" || (configured !== "\n" && process.platform === "win32");
    return crlf ? lf.replace(/\n/g, "\r\n") : lf;
  }
  return eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, "\r\n") : lf;
}

/** Ensure the parent directory exists before creating a file (createFile does not create directories) */
async function ensureParentDir(uri: vscode.Uri): Promise<void> {
  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // Directory already exists or cannot be created: let createFile report the error, so the real cause is not swallowed
  }
}
