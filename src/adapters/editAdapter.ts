import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget } from "../paths";
import type { EditApplyParams, EditApplyResult } from "../protocol";

/**
 * 唯一写入通道（README §10.2）。
 *
 * 四条硬规则：
 *   1. 用 WorkspaceEdit 而不是 TextEditor.edit（不依赖编辑器可见、进 undo 栈）
 *   2. 一次 applyEdit = 一个 undo 单元
 *   3. expectedVersion 不匹配 → 拒绝写入并回报 conflict（不覆盖用户的编辑）
 *   4. 先算后写：newText 由内核算好，这里不解析 patch、不做容错
 */
export function createEditAdapter(logger: Logger) {
  return {
    async apply(params: EditApplyParams, ctx: InboundRequestContext): Promise<EditApplyResult> {
      ctx.throwIfCancelled();
      const uri = resolveTarget(params.path);
      const op = params.op ?? "write";

      let version: number | undefined;
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        version = doc.version;
        if (typeof params.expectedVersion === "number" && params.expectedVersion !== doc.version) {
          logger.warn(`edit.apply 版本冲突: ${params.path} 期望 v${params.expectedVersion} 实际 v${doc.version}`);
          return {
            applied: false,
            conflict: true,
            version: doc.version,
            message: `文件已被修改（期望 v${params.expectedVersion}，实际 v${doc.version}），请重新读取后再改`,
          };
        }
      } catch {
        // 文件不存在：只有 write 允许继续（等价于新建），delete 直接失败
        if (op === "delete" || typeof params.expectedVersion === "number") {
          return { applied: false, message: `文件不存在：${params.path}` };
        }
      }

      const edit = new vscode.WorkspaceEdit();
      if (op === "delete") {
        edit.deleteFile(uri, { ignoreIfNotExists: false, recursive: false });
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        const end = doc.positionAt(doc.getText().length);
        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), params.newText);
      }

      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        return { applied: false, version, message: "WorkspaceEdit 被拒绝（文件可能被锁定或已被外部修改）" };
      }

      if (op === "write") {
        const reopened = await vscode.workspace.openTextDocument(uri);
        version = reopened.version;
      }
      logger.info(`edit.apply ${op} ${params.path}${params.reason ? ` (${params.reason})` : ""}`);
      return { applied: true, version };
    },
  };
}
