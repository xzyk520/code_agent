/**
 * Protocol definitions between shell and core (README §4.5).
 *
 * Transport: NDJSON over the child process's stdin/stdout (one JSON per line), JSON-RPC 2.0 style.
 * Directions:
 *   - Shell → core (CoreApi): initialize / chat.send / proposal.read / proposal.decide / session.abort / model.reload / shutdown
 *   - Core → shell (ShellMethods): fs.read / fs.list / search.grep / symbols.outline / diagnostics.get /
 *                                 symbols.search / symbols.references / edit.apply /
 *                                 checkpoint.create / checkpoint.restore / diff.open /
 *                                 confirm.ask / secrets.get / run
 *   - Core → shell notifications: ui.delta / ui.tool / ui.usage / proposal.changed / log
 *
 * ⚠️ Changing this file means changing the protocol: you must also update beecode/ipc.py and bump PROTOCOL_VERSION by 1.
 */
export const PROTOCOL_VERSION = 39;

// ─────────────────────────── Messages ───────────────────────────

/**
 * JSON-RPC id. The spec allows a number or a string.
 *
 * Requests we send ourselves always use a number (an incrementing counter, easy to match),
 * but a request we **receive** may have been sent by the peer as a string, and must be echoed back unchanged.
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

/** Protocol-level error codes (HTTP-like, but not HTTP) */
export const RpcError = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** Business errors thrown by tools/adapters */
  SHELL_ERROR: -32000,
  VERSION_MISMATCH: -32010,
  CONFLICT: -32011,
  NOT_FOUND: -32012,
  DENIED: -32013,
} as const;

/**
 * Maps an adapter exception to a protocol error code.
 *
 * This lives in exactly one place: client and server used to each have their own copy,
 * and changing one while forgetting the other made them drift apart.
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

/** Request/response: has both `id` and `method`. An id of either number or string counts. */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  const candidate = msg as JsonRpcRequest;
  return (
    (typeof candidate.id === "number" || typeof candidate.id === "string") &&
    typeof candidate.method === "string"
  );
}

/** Response: has `id` but no `method`. Used to discriminate before settling (cannot be confused with a request). */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcSuccess | JsonRpcFailure {
  const candidate = msg as { id?: unknown; method?: unknown };
  return (
    (typeof candidate.id === "number" || typeof candidate.id === "string") &&
    typeof candidate.method !== "string"
  );
}

// ────────────────────── Core → shell (implemented by the shell) ──────────────────────

export interface TextRangeDto {
  startLine: number; // 1-based
  endLine: number;   // 1-based, inclusive
}

export interface FsReadParams {
  /** main = main agent; subagent = subagent (affects how paths outside the workspace are judged) */
  role?: "main" | "subagent"; path: string; startLine?: number; endLine?: number }
export interface FsReadResult {
  text: string;
  /** Editor document version; omitted for disk/streaming reads (0 would be confused with a real version 0) */
  version?: number;
  /** Total line count; may be unknown when a streaming read has not reached the end of the file */
  totalLines?: number;
  /** Line range actually returned this time (1-based) */
  startLine: number;
  endLine: number;
  /** Whether it was truncated by the per-call limit (lines or bytes) */
  truncated: boolean;
}

export interface FsListParams {
  glob?: string;
  /** `null` = no filtering at all (passed straight through to findFiles); omitted = use the default exclusions */
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
  /** Return only "which files matched and how many times each", without line text (used in the recall phase; saves an order of magnitude of tokens) */
  filesOnly?: boolean;
  /** Case-sensitive (default false: code search is usually case-insensitive, but finding constants/type names needs it on) */
  caseSensitive?: boolean;
  /** `null` = no filtering at all (passed through to findFiles); omitted = default exclusions */
  exclude?: string | null;
}
export interface GrepHit {
  path: string;
  line: number;
  col: number;
  /** Raw matched line (bare line, without the line-number prefix) */
  text: string;
  /** How many matches on this line (returned only when > 1) */
  count?: number;
  /** Context snippet (returned when `contextLines > 0`, with line numbers and ▶ markers) */
  context?: string;
}
export interface GrepFileHit {
  path: string;
  /** Match count; recorded as the cap when the per-file limit is reached */
  matches: number;
  /** true = this file has more matches than the counting cap (`matches` is only a lower bound) */
  capped?: boolean;
}
export interface SearchGrepResult {
  hits: GrepHit[];
  /** Returned when `filesOnly: true`: files + match counts (no line text, saves tokens) */
  files?: GrepFileHit[];
  truncated: boolean;
}

export interface SymbolsOutlineParams { path: string }
export interface SymbolDto {
  name: string;
  kind: string;
  container?: string;
  /** The whole symbol (including leading comments/docstring): used by `read_symbol` */
  range: TextRangeDto;
  /** Position of the identifier itself (with column): needed by `references` (using the start line of the range often lands in a comment) */
  selection?: SymbolSelectionDto;
}
export interface SymbolsOutlineResult { symbols: SymbolDto[]; source: "lsp" | "none" }

/** Exact position of an identifier (1-based line and column) */
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
  /** lsp = the language service's workspace/symbol; fallback = grep + outline scan; none = neither produced results */
  source: "lsp" | "fallback" | "none";
  truncated: boolean;
}

export interface SymbolsReferencesParams {
  path: string;
  /** 1-based line; the range.startLine obtained from outline works fine */
  line: number;
  /** 1-based column, default 1 */
  column?: number;
  maxResults?: number;
}
export interface ReferenceHitDto { path: string; line: number; col: number; text?: string }
export interface SymbolsReferencesResult { locations: ReferenceHitDto[]; truncated: boolean }

export interface DiagnosticsGetParams {
  /** Only look at this file; omitted = everything (only files already analyzed by the language service) */
  path?: string;
  /** Return only diagnostics at or above this severity (default hint = all) */
  minSeverity?: "error" | "warning" | "info" | "hint";
  /** Maximum number of items to return (default 200, hard cap 2000) */
  maxItems?: number;
  /** Whether to include node_modules/.git and files ignored by .gitignore (default false) */
  includeIgnored?: boolean;
}

export interface DiagnosticDto {
  path: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  /** Diagnostic code: `TS2322` / `no-unused-vars` / `E501` … (the strongest clue for the model to locate a problem) */
  code?: string;
  source?: string;
  range: {
    startLine: number;
    endLine: number;
    /** 1-based column, optional (older clients may not send it) */
    startColumn?: number;
    endColumn?: number;
  };
}

export interface DiagnosticsGetResult {
  items: DiagnosticDto[];
  /** Total count after filtering, before truncation */
  total: number;
  truncated: boolean;
}

/** The core computes the new text; the shell is responsible for writing it to disk (the only write channel). */
export interface EditApplyParams {
  /** main = main agent; subagent = subagent (defaults to main) */
  role?: "main" | "subagent";
  path: string;
  newText: string;
  /** write = replace the whole file; delete = delete the file (newText is ignored) */
  op?: "write" | "delete";
  /** File version the core expects; the write is rejected if it does not match the current TextDocument.version */
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
  /** Lightweight mode: snapshot only these paths (relative to the workspace root). Empty = the whole workspace */
  paths?: string[];
}
export interface CheckpointCreateResult {
  id: string;
  files: number;
  /** true = no checkpoint was created this time (feature disabled / no workspace); in that case id is an empty string */
  skipped?: boolean;
  /** Why it was skipped, for the core and the logs */
  reason?: string;
}

/**
 * Restores a checkpoint.
 *
 * Only **files** are restored: session/task state belongs to the core, which composes the
 * "whole-turn rollback" itself (reset its own state first, then call this method to roll the files back).
 */
export interface CheckpointRestoreParams {
  id: string;
}
export interface CheckpointRestoreResult { restored: string[] }

export interface DiffOpenParams { path: string; baseText: string; title?: string }
export interface DiffOpenResult { opened: boolean }

export interface ConfirmAskParams {
  question: string;
  /** One sentence explaining "why we are asking" — shown under each option so the user does not confirm blindly */
  detail?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  /**
   * If provided, the user can choose "remember this choice"; the next call with the same key
   * returns immediately instead of prompting again.
   * Do **not** use this for safety gates; only for low-risk confirmations.
   */
  rememberKey?: string;
}
export interface ConfirmAskResult { choice: string | null }

export interface RunParams {
  command: string;
  /** main = main agent; subagent = subagent (defaults to main) */
  role?: "main" | "subagent";
  /** Directory relative to the workspace; omitted = the workspace root */
  cwd?: string;
  timeoutMs?: number;
  /** How long to wait before returning a running status (not the timeout that kills the process) */
  yieldMs?: number;
  /** Requested execution environment: sandbox-readonly = read-only Docker; sandbox = Docker with a writable workspace; sandbox-network = Docker + network; host = the real system shell */
  sandbox?: "sandbox-readonly" | "sandbox" | "sandbox-network" | "host";
  /** sandbox-network / host requests must state a justification (shown to the user for approval) */
  justification?: string;
}
export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Output was truncated because it exceeded the limit */
  truncated: boolean;
  durationMs: number;
  sandbox: "none" | "docker-readonly" | "docker" | "docker-network" | "host" | "host-readonly";
  /** Killed by timeout (exitCode is usually 124) */
  killed: boolean;
  /** Background job id for long commands; when present the command is still running */
  jobId?: string;
  status?: "running" | "exited";
  /** Milliseconds elapsed from start to this return */
  elapsedMs?: number;
  /** Moved to the background after first exceeding the foreground wait */
  backgrounded?: boolean;
  /** Whether this command_wait read any new output */
  hasNewOutput?: boolean;
  /** Running with no new output */
  noNewOutput?: boolean;
  /** Background/polling notice shown to the model */
  notice?: string;
  /** Current phase inferred from the tail of the output */
  progress?: string;
  /** Milliseconds since the most recent new output; undefined when there has been no output */
  outputAgeMs?: number;
}

export interface CommandWaitParams {
  jobId: string;
  /** Maximum wait for this call; default 60000, cap 300000 */
  yieldMs?: number;
}

export interface CommandTerminateParams {
  jobId: string;
}

export interface CommandJobInfo {
  jobId: string;
  command: string;
  status: "running" | "exited";
  elapsedMs: number;
  outputAgeMs?: number;
  sandbox: RunResult["sandbox"];
}

export interface CommandListResult {
  jobs: CommandJobInfo[];
}

/** Input for one round of summarization */
export interface TurnSummaryInput {
  intent: string;
  assistant?: string;
  tools?: string[];
  files?: string[];
  /** One observation per line (tool name + result summary), so the summary can judge "what was done" */
  observations?: string[];
  /** Diagrams generated this round (the summary should mention their topics) */
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
  "command.wait": CommandWaitParams;
  "command.terminate": CommandTerminateParams;
  "command.list": Record<string, never>;
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
  "command.wait": RunResult;
  "command.terminate": RunResult;
  "command.list": CommandListResult;
}

export type ShellMethod = keyof ShellMethodParams;

// ────────────────────── Shell → core (implemented by the core) ──────────────────────

export type Mode = "chat" | "builder" | "debugger";

export interface ModelConfigDto {
  /** Vision capability: auto = try first and self-heal after a rejection; on/off = explicit declaration */
  supportsVision?: "auto" | "on" | "off";
  /** Whether to send reasoning content back to the server: auto = turn it on automatically after a rejection; always/never = force it */
  reasoningReplay?: "auto" | "always" | "never";
  baseUrl: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  /** Model context window (tokens); in-turn compaction computes its budget from this */
  contextWindow?: number;
}

/** Model config for the subagent (optional; when omitted the main agent's is used verbatim) */
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
  /** Timeout for long tools such as command execution / spawning a subagent (milliseconds) */
  longToolTimeoutMs?: number;
  /** Step limit after automatically relaxing for a large task */
  largeTaskSteps?: number;
  /** Token budget for one turn (input + output) */
  maxTurnTokens?: number;
  /** Wall-clock budget for one turn (seconds); used for ordinary tasks */
  maxTurnSeconds?: number;
  /** Response deadline for the main agent model on a large task (seconds) */
  largeTaskSeconds?: number;
  /** First-token timeout (seconds) */
  firstTokenSeconds?: number;
  /** Streaming token idle timeout (seconds) */
  idleSeconds?: number;
  /** Maximum number of tool calls to execute in a single assistant message */
  maxToolCallsPerBatch?: number;
  checkpointEnabled?: boolean;
  /** Passed only via stdin during the handshake; the core should keep it in memory only, never on disk or in logs */
  apiKey?: string;
  /** Subagent model config (when unset, the main agent's is used) */
  subagentConfig?: SubagentConfigDto;
  /** Subagent key (passed only via stdin; when unset, the main agent's key is used) */
  subagentApiKey?: string;
  /** Summary model (empty = use the main model) */
  summaryConfig?: ModelConfigDto;
  /** Summary model key (stdin only; when unset, the main key is used) */
  summaryApiKey?: string;
}

export interface InitializeResult {
  protocolVersion: number;
  coreVersion?: string;
}

/** Where the user's current cursor (or selection) sits; the core uses it to decide "what to read first" */
export interface FocusDto {
  path: string;
  /** Cursor line (1-based) */
  line: number;
  startLine: number;
  endLine: number;
  kind: "function" | "block";
  symbol?: string;
}

export interface Attachment {
  /** Unsaved temporary document (untitled:): `path` is only a display name and cannot be used for fs.read */
  untitled?: boolean;
  path: string;
  startLine?: number;
  endLine?: number;
  text?: string;
  kind?: "selection" | "file" | "diagnostic" | "focus";
  /** Symbol name for a focus attachment (for display) */
  symbol?: string;
}

/** One message in the session history (used to restore context after a reload; text only, without tool-call details) */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  /** Diagrams attached to an assistant message (turned into Mermaid fences in the history context) */
  diagrams?: DiagramDto[];
}

/** Intent analysis result from the previous turn (persisted by the shell so the core can still judge "whether this continues" after a restart) */
export interface LastIntentDto {
  mode: Mode;
  scale?: "small" | "large";
  needsProposal?: boolean;
  intent?: string;
  reason?: string;
}

export interface ChatSendParams {
  /** Cursor position for this turn (optional; the shell attaches the corresponding code block automatically) */
  focus?: FocusDto;
  sessionId: string;
  mode: Mode;
  text: string;
  attachments?: Attachment[];
  /**
   * Conversation from previous turns (supplied by the shell on reload recovery / "continue last time").
   * The core can rebuild its context from it; without it this is a brand-new session.
   */
  history?: ChatMessage[];
  /** Compacted summary of earlier turns (produced by contextBuilder; the core may optionally consume it) */
  summary?: string;
  /** Plan left unfinished in the previous turn (carried across turns) */
  plan?: PlanStep[];
  /** Previous turn's intent (read by the shell from session meta, so the core can judge continuation after a restart) */
  lastIntent?: LastIntentDto;
}

/** Proposal (virtual file): the core keeps the "corrected code" on its side, the shell pulls it on demand, and it is only written to disk after the user approves */
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

// ────────────────────── Core → shell notifications ──────────────────────

export interface UiDeltaParams { sessionId: string; text: string }
export interface UiToolParams {
  sessionId: string;
  name: string;
  args?: unknown;
  status: "start" | "end" | "error";
  summary?: string;
  /** Truncated text of the tool result (used for the history trace) */
  detail?: string;
  durationMs?: number;
}

/** Steps of one turn's trace (reasoning / tool / diagram / error) */
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
/** Subagent progress (rendered as a collapsible card in the panel) */
export interface UiSubagentParams {
  sessionId: string;
  /** Subagent instance id; there may be several in the same turn */
  id: string;
  status: "start" | "tool" | "end";
  task?: string;
  maxSteps?: number;
  /** Valid when status=tool */
  tool?: { name: string; status: "start" | "end" | "error"; summary?: string };
  steps?: number;
  toolCalls?: number;
  /** Valid when status=end: the conclusion (already truncated) */
  findings?: string;
  error?: string;
}

/** Intent analysis result: mode and user intent (the panel shows only the mode badge, not the analysis content) */
export interface UiIntentParams {
  sessionId: string;
  mode: "chat" | "builder" | "debugger";
  /** One-sentence user intent (persisted into the turn record for the model's summary) */
  intent: string;
  reason?: string;
  scale?: "small" | "large";
  needsProposal?: boolean;
  degraded?: boolean;
  /** Follow-up question: reuse the previous turn's intent (the classifier was not called) */
  reused?: boolean;
}

/** Plan (produced by the update_plan tool on large tasks) */
export interface PlanStep {
  text: string;
  status: "pending" | "doing" | "done";
}

/** One diagram generated by the model (Mermaid source; rendered by the frontend) */
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

/** The agent read a file (used for editor highlighting / panel file chips) */
export interface UiReadParams {
  sessionId: string;
  path: string;
  /** read_file only */
  startLine?: number;
  endLine?: number;
  /** Name of the tool that triggered the read */
  tool?: string;
}

/** Reasoning content delta (shown to the user only; never enters the context or touches disk) */
export interface UiReasoningParams {
  sessionId: string;
  text: string;
  /** Which model call this is (for segmented display) */
  round?: number;
}

export interface CommandWaitParams {
  jobId: string;
  /** Maximum wait for this call; default 60000, cap 300000 */
  yieldMs?: number;
}

export interface CommandTerminateParams {
  jobId: string;
}

export interface UiRetryParams {
  sessionId?: string;
  /** Which attempt this is (1-based) */
  attempt?: number;
  max?: number;
  delayMs?: number;
  reason?: string;
  status?: "waiting" | "starting" | "done";
}

export interface UiUsageParams {
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Time elapsed this turn (milliseconds), for live cost display in the panel */
  elapsedMs?: number;
  /** Cumulative time spent waiting for model responses (milliseconds) */
  modelWaitMs?: number;
  /** Cumulative tool execution time (milliseconds) */
  toolMs?: number;
}
/** Proposal set changed (metadata only; the body is pulled on demand via `proposal.read`) */
export interface ProposalChangedParams {
  added?: ProposalDto[];
  updated?: ProposalDto[];
  removed?: string[];
}
export interface ProposalDto {
  id: string;
  path: string;
  /** The document.version read when the proposal was generated; used as expectedVersion on accept, so new user edits are not overwritten */
  baseVersion?: number;
  additions?: number;
  deletions?: number;
  status: "pending" | "applied" | "discarded" | "stale";
  /** One-sentence description of what changed (shown on the card) */
  summary?: string;
}
export interface LogParams { level: "debug" | "info" | "warn" | "error"; msg: string; fields?: Record<string, unknown> }

// ─────────────────────── NDJSON framing ───────────────────────

/**
 * Splits the byte stream on line boundaries. JSON.stringify never emits a bare newline, so framing on `\n` is safe.
 * A single data event is not guaranteed to contain a whole number of lines — residual lines must be buffered.
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

  /** Emit the last line (which has no newline) on process exit */
  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length > 0) this.onLine(rest);
  }
}
