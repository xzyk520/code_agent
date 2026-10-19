import * as path from "node:path";
import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget } from "../paths";
import type { EditApplyParams, EditApplyResult } from "../protocol";

/** 单次写入上限：模型抽风生成几 MB 文本时，宁可拒绝也不要塞爆 undo 栈 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * 唯一写入通道（README §10.2）。
 *
 * 硬规则：
 *   1. 用 WorkspaceEdit 而不是 TextEditor.edit（不依赖编辑器可见、进 undo 栈）
 *   2. 一次 applyEdit = 一个 undo 单元
 *   3. expectedVersion 不匹配 → 拒绝写入并回报 conflict（不覆盖用户的编辑）
 *   4. 先算后写：newText 由内核算好，这里不解析 patch、不做容错
 *   5. 换行符跟随目标文件（CRLF 文件不会被写成 LF，否则 git 会显示整个文件都改了）
 *   6. 新建文件走 createFile + insert（replace 对不存在的文件无效），并自动建父目录
 *   7. 有未保存修改的文件拒绝 delete（否则用户的编辑会被静默丢掉）
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

      // 只打开一次：既用于版本比对，也用于决定「改已有文件」还是「新建文件」
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
        // delete 一个不存在的文件、或「期望某个版本」却读不到文件 —— 都是调用方状态过期
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
        // 文件已不存在，version 没有意义 —— 不要返回陈旧值
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

/** 打开文档；不存在（或不是文本文件）时返回 undefined，而不是抛错 */
async function openIfExists(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

/**
 * 统一换行符到目标文件的风格。
 *
 * 不这么做的话：CRLF 文件被整文件写成 LF → `git diff` 显示「整个文件都改了」，
 * 用户的 .gitattributes / editorconfig 规则全部被绕过。
 */
export function adaptEol(text: string, eol?: vscode.EndOfLine): string {
  const lf = text.replace(/\r\n/g, "\n");
  if (eol === undefined) {
    // 新文件：跟随 `files.eol`；auto 时按平台惯例
    const configured = vscode.workspace.getConfiguration("files").get<string>("eol");
    const crlf = configured === "\r\n" || (configured !== "\n" && process.platform === "win32");
    return crlf ? lf.replace(/\n/g, "\r\n") : lf;
  }
  return eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, "\r\n") : lf;
}

/** 新建文件前确保父目录存在（createFile 不会自动创建目录） */
async function ensureParentDir(uri: vscode.Uri): Promise<void> {
  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // 目录已存在或无法创建：交给 createFile 自己报错，避免吞掉真实原因
  }
}
