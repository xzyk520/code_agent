import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget, toWorkspaceRelative } from "../paths";
import type { DiagnosticDto, DiagnosticsGetParams, DiagnosticsGetResult } from "../protocol";
import { isIgnored } from "../workspaceIgnore";

/** Upper bound on diagnostics returned per query (excess is truncated and flagged truncated) */
const DEFAULT_MAX_ITEMS = 200;
const HARD_MAX_ITEMS = 2_000;

/** Severity sort weight: the smaller the number, the more severe */
const SEVERITY_RANK: Record<DiagnosticDto["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

/** Check for cancellation every N files (so Stop responds during long loops) */
const CANCEL_CHECK_EVERY = 50;

/**
 * LSP diagnostics: first-hand evidence for Debugger mode.
 *
 * ⚠️ **No diagnostics ≠ no problems**: `languages.getDiagnostics()` returns diagnostics
 * only for files the language service has already analyzed. Just after a window opens,
 * only the files that were opened may have diagnostics, so the core must not conclude
 * "the project has no compile errors" from this (say so when writing the Debugger prompt).
 */
export function createDiagnosticsAdapter(logger: Logger) {
  return {
    async get(params: DiagnosticsGetParams, ctx: InboundRequestContext): Promise<DiagnosticsGetResult> {
      ctx.throwIfCancelled();

      const maxItems = clamp(params.maxItems ?? DEFAULT_MAX_ITEMS, 1, HARD_MAX_ITEMS);
      const minRank = SEVERITY_RANK[params.minSeverity ?? "hint"];
      const includeIgnored = params.includeIgnored ?? false;

      // 1) Pick the candidate set: a single file or everything
      let entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
      if (params.path) {
        const uri = resolveTarget(params.path);
        entries = [[uri, vscode.languages.getDiagnostics(uri)]];
      } else {
        entries = vscode.languages.getDiagnostics();
      }

      // 2) Filter (ignore rules + severity threshold) and collect
      const collected: DiagnosticDto[] = [];
      let scanned = 0;
      for (const [uri, diagnostics] of entries) {
        scanned += 1;
        if (scanned % CANCEL_CHECK_EVERY === 0) ctx.throwIfCancelled();
        if (!includeIgnored && isIgnored(uri.fsPath)) continue;
        for (const diagnostic of diagnostics) {
          const severity = severityName(diagnostic.severity);
          if (SEVERITY_RANK[severity] > minRank) continue;
          collected.push(toDto(uri, diagnostic, severity));
        }
      }

      // 3) Sort by severity (errors first), then file and line, so the result is stable and readable
      collected.sort(compare);

      const total = collected.length;
      const items = collected.slice(0, maxItems);
      const truncated = total > items.length;

      logger.debug(
        `diagnostics.get${params.path ? ` ${params.path}` : "（全量）"} → ${items.length}/${total} 条` +
          `${truncated ? "（已截断）" : ""}`,
      );
      return { items, total, truncated };
    },
  };
}

function toDto(uri: vscode.Uri, diagnostic: vscode.Diagnostic, severity: DiagnosticDto["severity"]): DiagnosticDto {
  return {
    path: toWorkspaceRelative(uri.fsPath),
    severity,
    message: diagnostic.message,
    source: diagnostic.source,
    code: codeOf(diagnostic.code),
    range: {
      startLine: diagnostic.range.start.line + 1,
      endLine: diagnostic.range.end.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endColumn: diagnostic.range.end.character + 1,
    },
  };
}

/** `code` may be a string / number / `{ value, target }`; normalize it to a string */
function codeOf(code: vscode.Diagnostic["code"]): string | undefined {
  if (code === undefined) return undefined;
  if (typeof code === "string" || typeof code === "number") return String(code);
  return String(code.value);
}

function compare(a: DiagnosticDto, b: DiagnosticDto): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return a.range.startLine - b.range.startLine;
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
