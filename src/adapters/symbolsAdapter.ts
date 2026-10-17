import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget } from "../paths";
import type { SymbolDto, SymbolsOutlineParams, SymbolsOutlineResult } from "../protocol";

/**
 * 文件符号大纲 —— 函数边界就是「逐函数 Keep/Undo」的基础。
 *
 * ⚠️ 返回类型有两种形态（取决于语言扩展注册的 provider）：
 *   - DocumentSymbol[]：有 range / children，可嵌套
 *   - SymbolInformation[]：扁平，只有 location
 * 必须同时兼容，否则一换语言就崩。
 */
export function createSymbolsAdapter(logger: Logger) {
  return {
    async outline(params: SymbolsOutlineParams, ctx: InboundRequestContext): Promise<SymbolsOutlineResult> {
      ctx.throwIfCancelled();
      const uri = resolveTarget(params.path);

      const raw = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      );
      if (!raw || raw.length === 0) {
        logger.debug(`symbols.outline ${params.path} → 无 provider（该语言没装语言扩展？）`);
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
          });
          for (const child of node.children) visit(child, container ? `${container}.${node.name}` : node.name);
        } else {
          symbols.push({
            name: node.name,
            kind: symbolKindName(node.kind),
            container,
            range: {
              startLine: node.location.range.start.line + 1,
              endLine: node.location.range.end.line + 1,
            },
          });
        }
      };
      for (const node of raw) visit(node);

      logger.debug(`symbols.outline ${params.path} → ${symbols.length} 个符号`);
      return { symbols, source: "lsp" };
    },
  };
}

function symbolKindName(kind: vscode.SymbolKind): string {
  const name = vscode.SymbolKind[kind];
  return typeof name === "string" ? name : String(kind);
}
