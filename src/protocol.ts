/**
 * 壳 ↔ 内核的协议定义（README §4.5）。
 *
 * 传输：子进程 stdin/stdout 上的 NDJSON（一行一个 JSON），JSON-RPC 2.0 风格。
 * 方向：
 *   - 壳 → 内核（CoreApi）：initialize / chat.send / proposal.read / proposal.decide / session.abort / model.reload / shutdown
 *   - 内核 → 壳（ShellMethods）：fs.read / fs.list / search.grep / symbols.outline / diagnostics.get /
 *                                symbols.search / symbols.references / edit.apply /
 *                                checkpoint.create / checkpoint.restore / diff.open /
 *                                confirm.ask / secrets.get / run
 *   - 内核 → 壳 通知：ui.delta / ui.tool / ui.usage / proposal.changed / log
 *
 * ⚠️ 改这个文件 = 改协议，必须同时改 beecode/ipc.py 并把 PROTOCOL_VERSION +1。
 */
export const PROTOCOL_VERSION = 35;

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

/**
 * 把适配器异常映射成协议错误码。
 *
 * 只有这一份：之前 client / server 各写一遍，改一边忘另一边就会漂移。
 */
export function rpcCodeFor(err: unknown): number {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "PathPolicyError":
      return RpcError.DENIED;
    case "MethodNotFound":
      return RpcError.METHOD_NOT_FOUND;
    default:
      return RpcError.SHELL_ERROR;
  }
}

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

export interface FsReadParams {
  /** main = 主代理；subagent = 子代理（影响工作区外路径的判定） */
  role?: "main" | "subagent"; path: string; startLine?: number; endLine?: number }
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
  /** main = 主代理；subagent = 子代理（默认 main） */
  role?: "main" | "subagent";
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

export interface RunParams {
  command: string;
  /** main = 主代理；subagent = 子代理（默认 main） */
  role?: "main" | "subagent";
  /** 工作区相对目录；省略 = 工作区根 */
  cwd?: string;
  timeoutMs?: number;
}
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 输出超过上限被截断 */
  truncated: boolean;
  durationMs: number;
  sandbox: "none" | "docker";
  /** 超时被杀（exitCode 通常为 124） */
  killed: boolean;
}

/** 一轮用于总结的输入 */
export interface TurnSummaryInput {
  intent: string;
  assistant?: string;
  tools?: string[];
  files?: string[];
  /** 一行一条观察（工具名 + 结果摘要），供总结时判断"做了什么" */
  observations?: string[];
  /** 本轮生成的图（摘要时要提到图的主题） */
  diagrams?: DiagramDto[];
}

export interface ContextSummarizeParams {
  turns: TurnSummaryInput[];
}

export interface ContextSummarizeResult {
  summary: string;
  pairs: Array<{ intent: string; summary: string }>;
  usage?: { inputTokens?: number; outputTokens?: number };
}

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
  "context.summarize": ContextSummarizeParams;
  "run": RunParams;
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
  "context.summarize": ContextSummarizeResult;
  "run": RunResult;
}

export type ShellMethod = keyof ShellMethodParams;

// ────────────────────── 壳 → 内核（内核实现） ──────────────────────

export type Mode = "chat" | "builder" | "debugger";

export interface ModelConfigDto {
  /** 视觉能力：auto=先试，被拒后自愈；on/off=显式声明 */
  supportsVision?: "auto" | "on" | "off";
  /** 是否把思考内容回传给服务端：auto=被拒后自动打开；always/never=强制 */
  reasoningReplay?: "auto" | "always" | "never";
  baseUrl: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  /** 模型上下文窗口（token）；轮内压缩按它计算预算 */
  contextWindow?: number;
}

/** 子代理的模型配置（可选；省略则完全沿用主代理） */
export interface SubagentConfigDto {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  supportsVision?: "auto" | "on" | "off";
  maxSteps?: number;
  temperature?: number;
}

export interface InitializeParams {
  protocolVersion: number;
  workspaceRoots: string[];
  modelConfig: ModelConfigDto;
  maxSteps?: number;
  toolTimeoutMs?: number;
  /** 命令执行 / 派生子代理等长工具的超时（毫秒） */
  longToolTimeoutMs?: number;
  /** 大任务自动放宽后的步数上限 */
  largeTaskSteps?: number;
  /** 一轮的 token 预算（输入 + 输出） */
  maxTurnTokens?: number;
  /** 一轮的墙钟预算（秒）；普通任务用 */
  maxTurnSeconds?: number;
  /** 大任务的主 agent 模型响应时限（秒） */
  largeTaskSeconds?: number;
  /** 首 token 超时（秒） */
  firstTokenSeconds?: number;
  /** 流式 token 空闲超时（秒） */
  idleSeconds?: number;
  /** 一次 assistant 消息里最多执行多少个工具调用 */
  maxToolCallsPerBatch?: number;
  checkpointEnabled?: boolean;
  /** 只在握手时通过 stdin 传入；内核只应放内存，不落盘、不进日志 */
  apiKey?: string;
  /** 子代理模型配置（不填则沿用主代理） */
  subagentConfig?: SubagentConfigDto;
  /** 子代理的密钥（只经 stdin 传递；不填则沿用主代理密钥） */
  subagentApiKey?: string;
  /** 摘要模型（空 = 沿用主模型） */
  summaryConfig?: ModelConfigDto;
  /** 摘要模型密钥（只经 stdin；不填则沿用主密钥） */
  summaryApiKey?: string;
}

export interface InitializeResult {
  protocolVersion: number;
  coreVersion?: string;
}

/** 用户当前光标（或选区）所在位置；内核用它决定"先读哪里" */
export interface FocusDto {
  path: string;
  /** 光标行（1-based） */
  line: number;
  startLine: number;
  endLine: number;
  kind: "function" | "block";
  symbol?: string;
}

export interface Attachment {
  /** 未保存的临时文档（untitled:）：`path` 只是显示名，不能用来 fs.read */
  untitled?: boolean;
  path: string;
  startLine?: number;
  endLine?: number;
  text?: string;
  kind?: "selection" | "file" | "diagnostic" | "focus";
  /** focus 附件对应的符号名（显示用） */
  symbol?: string;
}

/** 会话历史里的一条消息（重载后恢复上下文用；只带文本，不带工具调用细节） */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  /** 助手消息里附带的图（历史上下文里会转成 Mermaid 围栏） */
  diagrams?: DiagramDto[];
}

/** 上一轮的意图分析结果（壳持久化，内核重启后仍能判断"是否延续"） */
export interface LastIntentDto {
  mode: Mode;
  scale?: "small" | "large";
  needsProposal?: boolean;
  intent?: string;
  reason?: string;
}

export interface ChatSendParams {
  /** 本轮光标位置（可选；壳会自动附上对应代码块） */
  focus?: FocusDto;
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
  /** 上一轮未完成的计划（跨轮延续） */
  plan?: PlanStep[];
  /** 上一轮意图（壳从 session meta 读取，供内核重启后判断延续） */
  lastIntent?: LastIntentDto;
}

/** 提案（虚拟文件）：内核把「修正后的代码」暂存在自己那边，壳按需拉取，用户批准后才真正落盘 */
export interface ProposalReadParams { id: string }
export interface ProposalReadResult { text: string }
export interface ProposalDecideParams { id: string; decision: "accept" | "reject" }
export interface ProposalDecideResult { ok: boolean }

export interface SessionAbortParams { sessionId: string }
export interface ModelReloadParams {
  modelConfig: ModelConfigDto;
  apiKey?: string;
  subagentConfig?: SubagentConfigDto;
  subagentApiKey?: string;
  summaryConfig?: ModelConfigDto;
  summaryApiKey?: string;
}

// ────────────────────── 内核 → 壳 通知 ──────────────────────

export interface UiDeltaParams { sessionId: string; text: string }
export interface UiToolParams {
  sessionId: string;
  name: string;
  args?: unknown;
  status: "start" | "end" | "error";
  summary?: string;
  /** 工具结果的截断文本（用于历史轨迹） */
  detail?: string;
  durationMs?: number;
}

/** 一轮的轨迹步骤（思考 / 工具 / 图 / 错误） */
export interface TraceStepDto {
  type: "reasoning" | "tool" | "diagram" | "plan" | "error";
  round?: number;
  name?: string;
  args?: string;
  status?: "start" | "end" | "error";
  summary?: string;
  detail?: string;
  durationMs?: number;
  text?: string;
  title?: string;
}
/** 子代理的进度（面板里渲染成可折叠卡片） */
export interface UiSubagentParams {
  sessionId: string;
  /** 子代理实例 id，同一轮里可能同时有多个 */
  id: string;
  status: "start" | "tool" | "end";
  task?: string;
  maxSteps?: number;
  /** status=tool 时有效 */
  tool?: { name: string; status: "start" | "end" | "error"; summary?: string };
  steps?: number;
  toolCalls?: number;
  /** status=end 时有效：结论（已截断） */
  findings?: string;
  error?: string;
}

/** 意图分析结果：模式与用户意图（面板只显示模式徽标，不显示分析内容） */
export interface UiIntentParams {
  sessionId: string;
  mode: "chat" | "builder" | "debugger";
  /** 一句话用户意图（会被持久化进轮次记录，供模型总结） */
  intent: string;
  reason?: string;
  scale?: "small" | "large";
  needsProposal?: boolean;
  degraded?: boolean;
  /** 连续追问：沿用上一轮意图（未调用分类器） */
  reused?: boolean;
}

/** 计划（大任务时由 update_plan 工具产出） */
export interface PlanStep {
  text: string;
  status: "pending" | "doing" | "done";
}

/** 模型生成的一张图（Mermaid 源码；由前端渲染） */
export interface DiagramDto {
  id: string;
  kind: string;
  title?: string;
  source: string;
}

export interface UiDiagramParams {
  sessionId: string;
  diagram: DiagramDto;
}

export interface UiPlanParams {
  sessionId: string;
  steps: PlanStep[];
}

/** agent 读了一个文件（用于编辑器高亮 / 面板文件 chips） */
export interface UiReadParams {
  sessionId: string;
  path: string;
  /** 仅 read_file 有 */
  startLine?: number;
  endLine?: number;
  /** 触发读取的工具名 */
  tool?: string;
}

/** 思考内容增量（只给用户看，不进上下文、不落盘） */
export interface UiReasoningParams {
  sessionId: string;
  text: string;
  /** 第几次模型调用（用于分段显示） */
  round?: number;
}

export interface UiUsageParams {
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** 本轮已耗时（毫秒），用于面板实时显示成本 */
  elapsedMs?: number;
  /** 等待模型响应的累计耗时（毫秒） */
  modelWaitMs?: number;
  /** 工具执行累计耗时（毫秒） */
  toolMs?: number;
}
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
