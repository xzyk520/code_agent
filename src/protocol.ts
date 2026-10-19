/**
 * 壳 ↔ 内核的协议定义（README §4.5）。
 *
 * 传输：子进程 stdin/stdout 上的 NDJSON（一行一个 JSON），JSON-RPC 2.0 风格。
 * 方向：
 *   - 壳 → 内核（CoreApi）：initialize / chat.send / proposal.read / proposal.decide / session.abort / model.reload / shutdown
 *   - 内核 → 壳（ShellMethods）：fs.read / fs.list / search.grep / symbols.outline / diagnostics.get /
 *                                edit.apply / checkpoint.create / checkpoint.restore / diff.open /
 *                                confirm.ask / secrets.get
 *   - 内核 → 壳 通知：ui.delta / ui.tool / ui.usage / pending.changed / log
 *
 * ⚠️ 改这个文件 = 改协议，必须同时改 beecode/ipc.py 并把 PROTOCOL_VERSION +1。
 */
export const PROTOCOL_VERSION = 10;

// ─────────────────────────── 报文 ───────────────────────────

/**
 * JSON-RPC 的 id。规范允许 number 或 string。
 *
 * 我们自己发出的请求一律用 number（自增计数器，好匹配），
 * 但**收到**的请求可能是对端用 string 发的，必须原样回显。
 */
export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
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
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
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
  VERSION_MISMATCH: -32010,
  CONFLICT: -32011,
  NOT_FOUND: -32012,
  DENIED: -32013,
} as const;

/** 请求/响应：同时有 `id` 与 `method`。id 为 number 或 string 都算。 */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  const candidate = msg as JsonRpcRequest;
  return (
    (typeof candidate.id === "number" || typeof candidate.id === "string") &&
    typeof candidate.method === "string"
  );
}

/** 响应：有 `id` 但没有 `method`。用于 settle 前判别（不会与 request 混淆）。 */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcSuccess | JsonRpcFailure {
  const candidate = msg as { id?: unknown; method?: unknown };
  return (
    (typeof candidate.id === "number" || typeof candidate.id === "string") &&
    typeof candidate.method !== "string"
  );
}

// ────────────────────── 内核 → 壳（shell 实现） ──────────────────────

export interface TextRangeDto {
  startLine: number; // 1-based
  endLine: number;   // 1-based, inclusive
}

export interface FsReadParams { path: string; startLine?: number; endLine?: number }
export interface FsReadResult {
  text: string;
  /** 编辑器文档版本；走磁盘/流式读取时省略（0 会和真实版本 0 混淆） */
  version?: number;
  /** 总行数；流式读取没读到文件尾时可能未知 */
  totalLines?: number;
  /** 本次实际返回的行范围（1-based） */
  startLine: number;
  endLine: number;
  /** 是否因为单次上限被截断（行数或字节） */
  truncated: boolean;
}

export interface FsListParams {
  glob?: string;
  /** `null` = 完全不过滤（透传给 findFiles）；省略 = 用默认排除 */
  exclude?: string | null;
  maxResults?: number;
}
export interface FsListResult { paths: string[]; truncated: boolean }

export interface SearchGrepParams {
  query: string;
  regex?: boolean;
  glob?: string;
  contextLines?: number;
  maxResults?: number;
  /** 只返回「哪些文件命中、各几次」，不返回行文本（召回阶段用，token 省一个数量级） */
  filesOnly?: boolean;
  /** 区分大小写（默认 false：代码搜索通常不区分，但找常量/类型名时需要开） */
  caseSensitive?: boolean;
  /** `null` = 完全不过滤（透传 findFiles）；省略 = 默认排除 */
  exclude?: string | null;
}
export interface GrepHit {
  path: string;
  line: number;
  col: number;
  /** 命中行原文（裸行，不含行号前缀） */
  text: string;
  /** 这一行里命中了多少次（>1 时才返回） */
  count?: number;
  /** 上下文片段（`contextLines > 0` 时返回，带行号与 ▶ 标记） */
  context?: string;
}
export interface GrepFileHit {
  path: string;
  /** 命中次数；达到单文件上限时按上限记 */
  matches: number;
  /** true = 该文件命中数超过统计上限（`matches` 只是下限） */
  capped?: boolean;
}
export interface SearchGrepResult {
  hits: GrepHit[];
  /** `filesOnly: true` 时返回：文件 + 命中次数（不含行文本，省 token） */
  files?: GrepFileHit[];
  truncated: boolean;
}

export interface SymbolsOutlineParams { path: string }
export interface SymbolDto {
  name: string;
  kind: string;
  container?: string;
  /** 整个符号（含前导注释/docstring）：`read_symbol` 用它 */
  range: TextRangeDto;
  /** 标识符本身的位置（含列）：`references` 要用它（用 range 起始行常常落在注释里） */
  selection?: SymbolSelectionDto;
}
export interface SymbolsOutlineResult { symbols: SymbolDto[]; source: "lsp" | "none" }

/** 标识符的精确位置（1-based 行列） */
export interface SymbolSelectionDto {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SymbolHitDto {
  path: string;
  name: string;
  kind: string;
  container?: string;
  range: TextRangeDto;
  selection?: SymbolSelectionDto;
}
export interface SymbolsSearchParams {
  query: string;
  maxResults?: number;
}
export interface SymbolsSearchResult {
  symbols: SymbolHitDto[];
  /** lsp = 语言服务的 workspace/symbol；fallback = grep + outline 扫描；none = 都没结果 */
  source: "lsp" | "fallback" | "none";
  truncated: boolean;
}

export interface SymbolsReferencesParams {
  path: string;
  /** 1-based 行；用 outline 拿到的 range.startLine 即可 */
  line: number;
  /** 1-based 列，默认 1 */
  column?: number;
  maxResults?: number;
}
export interface ReferenceHitDto { path: string; line: number; col: number; text?: string }
export interface SymbolsReferencesResult { locations: ReferenceHitDto[]; truncated: boolean }

export interface DiagnosticsGetParams {
  /** 只看这个文件；省略 = 全量（只包含已被语言服务分析过的文件） */
  path?: string;
  /** 只返回不低于该严重度的诊断（默认 hint = 全部） */
  minSeverity?: "error" | "warning" | "info" | "hint";
  /** 最多返回多少条（默认 200，硬上限 2000） */
  maxItems?: number;
  /** 是否包含 node_modules/.git 与 .gitignore 忽略的文件（默认 false） */
  includeIgnored?: boolean;
}

export interface DiagnosticDto {
  path: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  /** 诊断码：`TS2322` / `no-unused-vars` / `E501` …（模型定位问题的最强线索） */
  code?: string;
  source?: string;
  range: {
    startLine: number;
    endLine: number;
    /** 1-based 列，可选（旧客户端可能没有） */
    startColumn?: number;
    endColumn?: number;
  };
}

export interface DiagnosticsGetResult {
  items: DiagnosticDto[];
  /** 过滤后、截断前的总数 */
  total: number;
  truncated: boolean;
}

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

export interface CheckpointCreateParams {
  label?: string;
  /** 轻量模式：只快照这些路径（相对工作区根）。留空 = 整个工作区 */
  paths?: string[];
}
export interface CheckpointCreateResult {
  id: string;
  files: number;
  /** true = 这次没有建检查点（设置关闭 / 没工作区），此时 id 为空串 */
  skipped?: boolean;
  /** skipped 的原因，给内核与日志看 */
  reason?: string;
}

/**
 * 恢复检查点。
 *
 * 只恢复**文件**：会话/任务状态属于内核自己，由内核合成「整轮回滚」
 * （先重置自身状态，再调这个方法把文件退回去）。
 */
export interface CheckpointRestoreParams {
  id: string;
}
export interface CheckpointRestoreResult { restored: string[] }

export interface DiffOpenParams { path: string; baseText: string; title?: string }
export interface DiffOpenResult { opened: boolean }

export interface ConfirmAskParams {
  question: string;
  /** 一句解释「为什么要问」——会显示在每个选项下方，别让用户盲点确认 */
  detail?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  /**
   * 若提供，用户可以选「记住这次选择」；下次同一 key 直接返回，不再弹窗。
   * 安全门闸**不要**用它；只用于低风险确认。
   */
  rememberKey?: string;
}
export interface ConfirmAskResult { choice: string | null }

export interface SecretsGetParams { key: string }
export interface SecretsGetResult { value: string | null }

export interface ShellMethodParams {
  "fs.read": FsReadParams;
  "fs.list": FsListParams;
  "search.grep": SearchGrepParams;
  "symbols.outline": SymbolsOutlineParams;
  "symbols.search": SymbolsSearchParams;
  "symbols.references": SymbolsReferencesParams;
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
  "symbols.search": SymbolsSearchResult;
  "symbols.references": SymbolsReferencesResult;
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

/** 会话历史里的一条消息（重载后恢复上下文用；只带文本，不带工具调用细节） */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface ChatSendParams {
  sessionId: string;
  mode: Mode;
  text: string;
  attachments?: Attachment[];
  /**
   * 之前轮次的对话（重载恢复 / "继续上次"时由壳带上）。
   * 内核可以据此重建上下文；不传就是全新会话。
   */
  history?: ChatMessage[];
  /** 早前轮次的压缩摘要（contextBuilder 产出；内核可选消费） */
  summary?: string;
}

/** 提案（虚拟文件）：内核把「修正后的代码」暂存在自己那边，壳按需拉取，用户批准后才真正落盘 */
export interface ProposalReadParams { id: string }
export interface ProposalReadResult { text: string }
export interface ProposalDecideParams { id: string; decision: "accept" | "reject" }
export interface ProposalDecideResult { ok: boolean }

export interface SessionAbortParams { sessionId: string }
export interface ModelReloadParams { modelConfig: ModelConfigDto; apiKey?: string }

// ────────────────────── 内核 → 壳 通知 ──────────────────────

export interface UiDeltaParams { sessionId: string; text: string }
export interface UiToolParams { sessionId: string; name: string; args?: unknown; status: "start" | "end" | "error"; summary?: string }
export interface UiUsageParams { sessionId?: string; inputTokens?: number; outputTokens?: number; costUsd?: number }
/** 提案集合变化（只有元数据，正文用 `proposal.read` 按需拉取） */
export interface ProposalChangedParams {
  added?: ProposalDto[];
  updated?: ProposalDto[];
  removed?: string[];
}
export interface ProposalDto {
  id: string;
  path: string;
  /** 生成提案时读到的 document.version；接受时作为 expectedVersion，防止覆盖用户的新编辑 */
  baseVersion?: number;
  additions?: number;
  deletions?: number;
  status: "pending" | "applied" | "discarded" | "stale";
  /** 一句话说明这次改了什么（显示在卡片上） */
  summary?: string;
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
