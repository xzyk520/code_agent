import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget, toWorkspaceRelative } from "../paths";
import type { DiagnosticDto, DiagnosticsGetParams, DiagnosticsGetResult } from "../protocol";

/** LSP 诊断：Debugger 模式的第一手证据 */
export function createDiagnosticsAdapter(logger: Logger) {
  return {
    async get(params: DiagnosticsGetParams, ctx: InboundRequestContext): Promise<DiagnosticsGetResult> {
      ctx.throwIfCancelled();
      const items: DiagnosticDto[] = [];

      if (params.path) {
        const uri = resolveTarget(params.path);
        collect(uri, vscode.languages.getDiagnostics(uri), items);
      } else {
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
          collect(uri, diagnostics, items);
        }
      }

      logger.debug(`diagnostics.get → ${items.length} 条`);
      return { items };
    },
  };
}

function collect(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[], out: DiagnosticDto[]): void {
  const path = toWorkspaceRelative(uri.fsPath);
  for (const d of diagnostics) {
    out.push({
      path,
      severity: severityName(d.severity),
      message: d.message,
      source: d.source,
      range: { startLine: d.range.start.line + 1, endLine: d.range.end.line + 1 },
    });
  }
}

function severityName(sev: vscode.DiagnosticSeverity): DiagnosticDto["severity"] {
  switch (sev) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}
