/**
 * 壳 ↔ 内核的协议定义（README §4.5）。
 *
 * 传输：子进程 stdin/stdout 上的 NDJSON（一行一个 JSON），JSON-RPC 2.0 风格。
 * 方向：
 *   - 壳 → 内核（CoreApi）：initialize / chat.send / review.* / session.abort / model.reload / shutdown
 *   - 内核 → 壳（ShellMethods）：fs.read / fs.list / search.grep / symbols.outline / diagnostics.get /
 *                                edit.apply / checkpoint.create / checkpoint.restore / diff.open /
 *                                confirm.ask / secrets.get
 *   - 内核 → 壳 通知：ui.delta / ui.tool / ui.usage / pending.changed / log
 *
 * ⚠️ 改这个文件 = 改协议，必须同时改 beecode/ipc.py 并把 PROTOCOL_VERSION +1。
 */
export const PROTOCOL_VERSION = 1;

// ─────────────────────────── 报文 ───────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

/** 协议层错误码（HTTP-like，但不是 HTTP） */
export const RpcError = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** 工具/适配器抛出的业务错误 */
  SHELL_ERROR: -32000,
  SIG_VERSION_MISMATCH: -32010,
  SIG_CONFLICT: -32011,
  SIG_NOT_FOUND: -32012,
  SIG_DENIED: -32013,
} as const;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return typeof (msg as JsonRpcRequest).id === "number" && typeof (msg as JsonRpcRequest).method === "string";
}

// ────────────────────── 内核 → 壳（shell 实现） ──────────────────────

export interface TextRangeDto {
  startLine: number; // 1-based
  endLine: number;   // 1-based, inclusive
}

export interface FsReadParams { path: string; startLine?: number; endLine?: number }
export interface FsReadResult { text: string; version: number; totalLines: number }

export interface FsListParams { glob?: string; exclude?: string; maxResults?: number }
export interface FsListResult { paths: string[] }

export interface SearchGrepParams {
  query: string;
  regex?: boolean;
  glob?: string;
  contextLines?: number;
  maxResults?: number;
}
export interface GrepHit { path: string; line: number; col: number; text: string }
export interface SearchGrepResult { hits: GrepHit[]; truncated: boolean }

export interface SymbolsOutlineParams { path: string }
export interface SymbolDto { name: string; kind: string; container?: string; range: TextRangeDto }
export interface SymbolsOutlineResult { symbols: SymbolDto[]; source: "lsp" | "none" }

export interface DiagnosticsGetParams { path?: string }
export interface DiagnosticDto { path: string; severity: "error" | "warning" | "info" | "hint"; message: string; source?: string; range: TextRangeDto }
export interface DiagnosticsGetResult { items: DiagnosticDto[] }

/** 内核算好新文本，壳负责落盘（唯一写入通道）。 */
export interface EditApplyParams {
  path: string;
  newText: string;
  /** write = 整文件替换；delete = 删除文件（newText 忽略） */
  op?: "write" | "delete";
  /** 内核期望的文件版本；与当前 TextDocument.version 不一致则拒绝写入 */
  expectedVersion?: number;
  reason?: string;
}
export interface EditApplyResult {
  applied: boolean;
  version?: number;
  conflict?: boolean;
  message?: string;
}

export interface CheckpointCreateParams { label?: string }
export interface CheckpointCreateResult { id: string; files: number }

export interface CheckpointRestoreParams { id: string; scope?: "files" | "task" | "both" }
export interface CheckpointRestoreResult { restored: string[] }

export interface DiffOpenParams { path: string; baseText: string; title?: string }
export interface DiffOpenResult { opened: boolean }

export interface ConfirmAskParams {
  question: string;
  detail?: string;
  options: Array<{ id: string; label: string; description?: string }>;
}
export interface ConfirmAskResult { choice: string | null }

export interface SecretsGetParams { key: string }
export interface SecretsGetResult { value: string | null }

export interface ShellMethodParams {
  "fs.read": FsReadParams;
  "fs.list": FsListParams;
  "search.grep": SearchGrepParams;
  "symbols.outline": SymbolsOutlineParams;
  "diagnostics.get": DiagnosticsGetParams;
  "edit.apply": EditApplyParams;
  "checkpoint.create": CheckpointCreateParams;
  "checkpoint.restore": CheckpointRestoreParams;
  "diff.open": DiffOpenParams;
  "confirm.ask": ConfirmAskParams;
  "secrets.get": SecretsGetParams;
}

export interface ShellMethodResults {
  "fs.read": FsReadResult;
  "fs.list": FsListResult;
  "search.grep": SearchGrepResult;
  "symbols.outline": SymbolsOutlineResult;
  "diagnostics.get": DiagnosticsGetResult;
  "edit.apply": EditApplyResult;
  "checkpoint.create": CheckpointCreateResult;
  "checkpoint.restore": CheckpointRestoreResult;
  "diff.open": DiffOpenResult;
  "confirm.ask": ConfirmAskResult;
  "secrets.get": SecretsGetResult;
}

export type ShellMethod = keyof ShellMethodParams;

// ────────────────────── 壳 → 内核（内核实现） ──────────────────────

export type Mode = "chat" | "builder" | "debugger";

export interface ModelConfigDto {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
}

export interface InitializeParams {
  protocolVersion: number;
  workspaceRoots: string[];
  modelConfig: ModelConfigDto;
  maxSteps?: number;
  toolTimeoutMs?: number;
  checkpointEnabled?: boolean;
  /** 只在握手时通过 stdin 传入；内核只应放内存，不落盘、不进日志 */
  apiKey?: string;
}

export interface InitializeResult {
  protocolVersion: number;
  coreVersion?: string;
}

export interface Attachment {
  path: string;
  startLine?: number;
  endLine?: number;
  text?: string;
  kind?: "selection" | "file" | "diagnostic";
}

export interface ChatSendParams {
  sessionId: string;
  mode: Mode;
  text: string;
  attachments?: Attachment[];
}

export interface ReviewTargetParams { pendingIds: string[] }
export interface ReviewAllParams { sessionId?: string }
export interface SessionAbortParams { sessionId: string }
export interface ModelReloadParams { modelConfig: ModelConfigDto; apiKey?: string }

// ────────────────────── 内核 → 壳 通知 ──────────────────────

export interface UiDeltaParams { sessionId: string; text: string }
export interface UiToolParams { sessionId: string; name: string; args?: unknown; status: "start" | "end" | "error"; summary?: string }
export interface UiUsageParams { sessionId?: string; inputTokens?: number; outputTokens?: number; costUsd?: number }
export interface PendingChangedParams {
  added?: PendingItemDto[];
  updated?: PendingItemDto[];
  removed?: string[];
}
export interface PendingItemDto {
  id: string;
  path: string;
  symbolPath?: string;
  status: "pending" | "kept" | "undone" | "stale";
  additions?: number;
  deletions?: number;
  risk?: "low" | "medium" | "high";
}
export interface LogParams { level: "debug" | "info" | "warn" | "error"; msg: string; fields?: Record<string, unknown> }

// ─────────────────────── NDJSON 分帧 ───────────────────────

/**
 * 按行切分字节流。JSON.stringify 不会产生裸换行，所以按 `\n` 分帧是安全的。
 * 不保证一次 data 事件里恰好是整数行 —— 必须缓存残行。
 */
export class LineReader {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) this.onLine(line);
    }
  }

  /** 进程退出时把最后一行（无换行）也吐出来 */
  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length > 0) this.onLine(rest);
  }
}
