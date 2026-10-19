import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import { resolveTarget, toWorkspaceRelative } from "../paths";
import type { DiagnosticDto, DiagnosticsGetParams, DiagnosticsGetResult } from "../protocol";
import { isIgnored } from "../workspaceIgnore";

/** 单次查询返回的诊断条数上限（超出会截断并标记 truncated） */
const DEFAULT_MAX_ITEMS = 200;
const HARD_MAX_ITEMS = 2_000;

/** 严重度排序权重：数字越小越严重 */
const SEVERITY_RANK: Record<DiagnosticDto["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

/** 每处理多少个文件检查一次取消（避免长循环里点停止没反应） */
const CANCEL_CHECK_EVERY = 50;

/**
 * LSP 诊断：Debugger 模式的第一手证据。
 *
 * ⚠️ **诊断为空 ≠ 代码没问题**：`languages.getDiagnostics()` 返回的是「已被语言服务
 * 分析过」的文件的诊断。刚打开窗口时可能只有打开过的那几个文件有诊断，
 * 内核不能据此得出「项目没有编译错误」的结论（写 Debugger 提示词时要说明）。
 */
export function createDiagnosticsAdapter(logger: Logger) {
  return {
    async get(params: DiagnosticsGetParams, ctx: InboundRequestContext): Promise<DiagnosticsGetResult> {
      ctx.throwIfCancelled();

      const maxItems = clamp(params.maxItems ?? DEFAULT_MAX_ITEMS, 1, HARD_MAX_ITEMS);
      const minRank = SEVERITY_RANK[params.minSeverity ?? "hint"];
      const includeIgnored = params.includeIgnored ?? false;

      // 1) 选定候选集合：单文件 or 全量
      let entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
      if (params.path) {
        const uri = resolveTarget(params.path);
        entries = [[uri, vscode.languages.getDiagnostics(uri)]];
      } else {
        entries = vscode.languages.getDiagnostics();
      }

      // 2) 过滤（忽略规则 + 严重度门槛）并收集
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

      // 3) 严重度优先排序（error 在前），同级按文件与行号，结果稳定可读
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

/** `code` 可能是 string / number / `{ value, target }`，统一成字符串 */
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
