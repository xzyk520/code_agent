import { execFile } from "node:child_process";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { clearRememberedChoices, createConfirmAdapter, createSecretAdapter } from "./adapters/interactionAdapter";
import { createDiagnosticsAdapter } from "./adapters/diagnosticsAdapter";
import { CheckpointAdapter } from "./adapters/checkpointAdapter";
import { DiffAdapter } from "./adapters/diffAdapter";
import { createEditAdapter } from "./adapters/editAdapter";
import { ProposalAdapter } from "./adapters/proposalAdapter";
import { createFsAdapter } from "./adapters/fsAdapter";
import { createSearchAdapter } from "./adapters/searchAdapter";
import { createSymbolsAdapter } from "./adapters/symbolsAdapter";
import { registerCommands, undeclaredCommands } from "./commands/register";
import { API_KEY_ENV, SUBAGENT_API_KEY_ENV, SUMMARY_API_KEY_ENV, defaultInstruction, describeConfig, isWorkspaceEmpty, newSessionId, readConfig, workspaceRoots, type ShellConfig } from "./config";
import { loadContract, verifyRegistration } from "./contract";
import type { CoreApi, InboundRequestContext } from "./coreApi";
import { CoreNotFoundError, describeLaunch, locateCore, resolvePython } from "./coreLocator";
import { exportDiagnostics as writeDiagnostics } from "./diagnostics";
import { MockCore } from "./dev/mockCore";
import { Logger } from "./log";
import { ChatViewProvider, type AttachedContext } from "./panel/chatViewProvider";
import { CommandTerminal } from "./commandTerminal";
import { ApprovalQueue } from "./approvalQueue";
import { LibraryViewProvider, type LibraryState } from "./panel/libraryViewProvider";
import { toWorkspaceRelative } from "./paths";
import { readFocusAtCursor, type FocusInfo } from "./focus";
import { FocusHighlighter } from "./focusDecoration";
import { CheckpointChatIndex } from "./checkpointChatIndex";
import { TurnStore } from "./turnStore";
import { SummaryStore } from "./summaryStore";
import { RetryStore, type PendingTurn, type RetryEvent } from "./retryStore";
import { tr, type Locale } from "./i18n";
import { mergeNotices } from "./notices";
import { buildRuleSet, evaluate, isSensitiveWrite, type Evaluation, type RuleSet } from "./permissions";
import { createRunAdapter, detectDocker, type CommandJob, type CommandJobSnapshot } from "./adapters/runAdapter";
import { ensureWorkspaceTrust, isTrusted, toggleWorkspaceTrust } from "./trust";
import { decide as decidePolicy, isHostReadOnlyCommand, isReadOnlyCommand, type AgentRole, type PolicyDecision } from "./policy";
import { addApprovedRoot, isInside, resolveTarget } from "./paths";
import { buildContext } from "./contextBuilder";
import { SessionStore, type TurnStatus } from "./sessionStore";
import { PROTOCOL_VERSION } from "./protocol";
import type {
  Attachment,
  FocusDto,
  ChatSendParams,
  InitializeParams,
  LogParams,
  Mode,
  ChatMessage,
  ProposalChangedParams,
  ProposalDto,
  CommandListResult,
  CommandTerminateParams,
  CommandWaitParams,
  RunParams,
  RunResult,
  UiDeltaParams,
  DiagramDto,
  TraceStepDto,
  PlanStep,
  UiIntentParams,
  UiPlanParams,
  UiDiagramParams,
  UiReadParams,
  UiReasoningParams,
  UiSubagentParams,
  UiToolParams,
  UiRetryParams,
  UiUsageParams,
} from "./protocol";
const SESSION_KEY = "beeCode.sessionId";
const execFileAsync = promisify(execFile);

import { PythonCore } from "./rpc/client";
import { ShellServer } from "./rpc/server";

let current: Shell | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  current = new Shell(context);
  await current.start();
}

export async function deactivate(): Promise<void> {
  await current?.dispose();
  current = undefined;
}

/**
 * Assembly root for the shell: all dependencies are wired up here once, and everything else depends only on interfaces.
 *
 * This class contains **no business logic**: prompts, the tool loop, retrieval, and patches all live in the Python core.
 * It only translates the core's intents into VS Code actions, and user actions into RPC calls.
 */
class Shell {
  private readonly log: Logger;
  private config: ShellConfig;
  private readonly server: ShellServer;
  private readonly diff: DiffAdapter;
  private readonly checkpoint: CheckpointAdapter;
  private readonly panel: ChatViewProvider;
  private readonly status: vscode.StatusBarItem;

  private core: CoreApi | undefined;
  private starting: Promise<CoreApi> | undefined;
  private sessionId: string;
  /** Number of messages already persisted (keeps the panel aligned with disk) */
  private persisted = 0;
  /** Mechanical summary of earlier turns (the L1 fed to the model) */
  /** This turn's assistant output (accumulated from ui.delta; persisted as one block after chatSend ends) */
  private assistantBuffer = "";
  private acceptAllCancelled = false;
  private acceptAllToken = 0;
  private readonly proposals: ProposalAdapter;
  private readonly confirm: ReturnType<typeof createConfirmAdapter>;
  private readonly runner: ReturnType<typeof createRunAdapter>;
  private readonly focusHighlight: FocusHighlighter;
  private readonly chatIndex: CheckpointChatIndex;
  private readonly turns: TurnStore;
  private readonly summaries: SummaryStore;
  private readonly retries: RetryStore;
  private turnIntent?: { intent: string; mode: Mode; scale?: "small" | "large"; needsProposal?: boolean; reason?: string };
  private readonly turnTools = new Set<string>();
  private readonly turnObservations: string[] = [];
  /** Diagrams generated this turn (attached to the assistant message + turn record) */
  private readonly turnDiagrams: DiagramDto[] = [];
  /** This turn's trace (reasoning/tools/diagrams), used for the collapsed card under the user message */
  private readonly turnTrace: TraceStepDto[] = [];
  /** This turn's error (when chat.send fails) */
  private turnError: string | undefined;
  /** This turn's plan (updated by ui.plan; written into the turn record and session meta) */
  private turnPlan: PlanStep[] = [];
  /** This turn's user message id (used for trajectory jumps on the right) */
  private turnUserMessageId: string | undefined;
  /** Scale of this turn's intent (determines the model response deadline) */
  private turnScale: "small" | "large" = "small";
  /** Accumulated usage for this turn (pushed via ui.usage) */
  private turnUsage?: {
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
    modelWaitMs: number;
    toolMs: number;
  };
  /** This turn's reasoning: accumulated per model call (persisted with the assistant message for later review) */
  private readonly reasoningSegments = new Map<number, string>();
  /** Highest sandbox permission level approved for each session */
  private readonly sandboxApprovals = new Map<string, number>();
  /** Sessions where the user approved restricted read-only host execution when Docker is unavailable */
  private readonly hostReadonlyApprovals = new Set<string>();
  /** Highest host write-fallback level approved per session when Docker is unavailable (tracked separately from Docker approvals) */
  private readonly hostFallbackApprovals = new Map<string, number>();
  /** The most recently sent request, used by "retry this turn" */
  private lastTurnRequest?: { text: string; mode: Mode; attachments: AttachedContext[] };
  /** Command-level checkpoint: one-click undo after the command finishes */
  private readonly commandCheckpoints = new Map<string, { files: string[]; command: string; createdAt: number }>();
  /** Long-running command jobs (no hard timeout; managed via command_wait / command_terminate) */
  private readonly commandJobs = new Map<
    string,
    {
      job: CommandJob;
      sessionId: string;
      command: string;
      checkpointId: string;
      sandbox: RunResult["sandbox"];
      finalized: boolean;
      backgrounded: boolean;
      resultDelivered: boolean;
      noticeSent: boolean;
      cancelled: boolean;
    }
  >();
  /** Attachment-limit notices: briefly aggregated and merged into a single toast (avoids a burst when selecting many files) */
  private readonly attachmentNotices: string[] = [];
  private attachmentNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly turnFiles = new Set<string>();
  /** Model summary cache: covered = number of covered turns; lines for incremental appends; persisted in SummaryStore */
  private summaryCache?: { covered: number; coveredMessageIndex: number; text: string; lines: string[] };
  private rules: RuleSet = buildRuleSet({});
  private trusted = false;
  private dockerAvailable = false;
  private readonly sessions: SessionStore;
  private libraryView?: LibraryViewProvider;
  private readonly commandTerminal = new CommandTerminal();
  private readonly approvals = new ApprovalQueue();
  /** Proposals whose diff has already been opened automatically (one preview per proposal). */
  private readonly autoOpenedProposals = new Set<string>();
  /** Where the previous turn stopped (persisted to disk so a reload can tell whether it can continue) */
  private turn: TurnStatus = "idle";
  private turnDetail: string | undefined;
  private readonly edit: ReturnType<typeof createEditAdapter>;
  private busy = false;
  private usage = "";
  /** Shutdown flag: keeps dispose idempotent and prevents starting the core or sending requests after shutdown */
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.log = new Logger();
    const read = readConfig();
    this.config = read.config;
    for (const problem of read.problems) this.log.warn(`Configuration problem: ${problem}`);
    this.server = new ShellServer(this.log);
    this.diff = new DiffAdapter(this.log);
    this.checkpoint = new CheckpointAdapter(
      context,
      this.log,
      this.config.checkpointEnabled,
      this.config.checkpointRetention,
    );

    // Write channel and proposal staging: this.edit is only actually called to write to disk when a proposal is "accepted"
    this.edit = createEditAdapter(this.log);
    this.confirm = createConfirmAdapter(context, this.log, (params) => this.panel?.requestApproval(params) ?? Promise.resolve(null));
    this.proposals = new ProposalAdapter(this.diff, this.edit, this.log);
    this.focusHighlight = new FocusHighlighter(this.log);
    this.chatIndex = new CheckpointChatIndex(nodePath.join(context.globalStorageUri.fsPath, "checkpoints"), this.log);
    this.turns = new TurnStore(nodePath.join(context.globalStorageUri.fsPath, "sessions"), this.log);
    this.summaries = new SummaryStore(nodePath.join(context.globalStorageUri.fsPath, "sessions"), this.log);
    this.retries = new RetryStore(nodePath.join(context.globalStorageUri.fsPath, "sessions"), this.log);
    this.runner = createRunAdapter({
      logger: this.log,
      policy: () => ({
        // Commands use Docker by default; when the agent explicitly requests host, runCommand's approval gate overrides this
        sandbox: this.dockerAvailable ? "docker" : "off",
        dockerImage: this.config.permissions.dockerImage,
      }),
      dockerAvailable: () => this.dockerAvailable,
    });
    this.sessions = new SessionStore(nodePath.join(context.globalStorageUri.fsPath, "sessions"), this.log);
    this.sessionId = context.globalState.get<string>(SESSION_KEY) ?? newSessionId();

    this.panel = new ChatViewProvider(context.extensionUri, {
      onSend: (text, mode, attachments) => void this.send(text, mode, attachments),
      onAccept: (ids) => void this.acceptProposals(ids),
      onReject: (ids) => void this.rejectProposals(ids),
      onAcceptAll: () => void this.acceptAllProposals(),
      onRejectAll: () => void this.rejectAllProposals(),
      onShowProposal: (id) => void this.showProposal(id),
      onAbort: () => void this.abort(),
      onOpenRead: (path, startLine, endLine) => void this.openRead(path, startLine, endLine),
      onRestoreCommand: (id) => void this.restoreCommandCheckpoint(id),
      onRetryTurn: () => void this.retryLastTurn(),
      onSessions: () => void this.showSessionSwitcher(),
      onModelSettings: () => void this.showModelSettings(),
      onLanguage: () => void vscode.commands.executeCommand("beeCode.ui.language.switch"),
      onAttachmentNotice: (message) => this.queueAttachmentNotice(message),
    }, this.config.attachments, this.config.language, this.config.fontSize);

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = "beeCode.chat.ask";
    this.status.show();

    this.registerAdapters();
  }

  async start(): Promise<void> {
    this.log.info(`Activated: ${describeConfig(this.config)}`);

    await this.ensureSession();
    await this.refreshPermissions();
    await this.initSandbox();

    // All "releasable resources" have exactly one owner: context.subscriptions.
    // VS Code disposes everything uniformly after deactivate(), so we never double-dispose.
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, this.panel, {
        webviewOptions: { retainContextWhenHidden: false },
      }),
    );

    this.libraryView = new LibraryViewProvider(this.context.extensionUri, {
      addSkillFolder: () => this.addSkillFolder(),
      addSkillFiles: (files) => this.addSkillFiles(files),
      addMcpFile: (files) => this.addMcpFile(files),
      addUris: (uris) => this.addLibraryUris(uris),
      removeSkill: (name) => this.removeSkill(name),
      removeMcp: (name) => this.removeMcp(name),
      refresh: async () => this.refreshLibrary(),
    });
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(LibraryViewProvider.viewId, this.libraryView, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    const registeredCommands = registerCommands(this.context, {
      panel: this.panel,
      log: this.log,
      configureModel: () => this.configureModel(),
      restartCore: () => this.restartCore(),
      setupPython: () => this.setupPython(),
      showCoreLogs: () => this.log.showStderr(),
      showCommandTerminal: () => this.commandTerminal.show(),
      restoreCheckpoint: () => this.restoreCheckpoint(),
      acceptAll: () => this.acceptAllProposals(),
      rejectAll: () => this.rejectAllProposals(),
      continueTurn: () => this.continueTurn(),
      regenerateProposal: () => this.regenerateProposal(),
      cancelAcceptAll: () => this.cancelAcceptAll(),
      newSession: () => this.newSession(),
      testModel: () => this.testModel("main"),
      configureSubagent: () => this.configureSubagent(),
      configureSummary: () => this.configureSummary(),
      testSubagent: () => this.testModel("subagent"),
      clearSubagentKey: () => this.clearSubagentKey(),
      redetectSandbox: () => this.redetectSandbox(),
      toggleTrust: async () => {
        await toggleWorkspaceTrust(this.context, this.log);
        await this.refreshPermissions();
      },
      clearModelKey: () => this.clearModelKey(),
      crashMock: () => {
        if (this.core instanceof MockCore) {
          this.core.simulateCrash(tr(this.config.language, "用户通过命令触发", "Triggered by a user command"));
        } else {
          void vscode.window.showInformationMessage(
            tr(this.config.language, "Bee Code: 当前内核不是 mock 模式，无法模拟崩溃。", "Bee Code: The current core is not in mock mode, so a crash cannot be simulated."),
          );
        }
      },
      pickSession: () => this.pickSession(),
      clearRemembered: () => {
        clearRememberedChoices(this.context);
        void vscode.window.showInformationMessage(
          tr(this.config.language, "Bee Code: 已清除记住的确认选择。", "Bee Code: Remembered confirmation choices cleared."),
        );
      },
      pickFiles: () => this.pickFiles(),
      focus: { fallbackLines: this.config.focus.fallbackLines, maxLines: this.config.focus.maxLines },
      highlightFocus: (focus: FocusInfo | undefined) => {
        if (this.config.focus.highlight) this.focusHighlight.show(focus);
      },
      exportDiagnostics: () => this.exportDiagnostics(),
      switchLanguage: () => this.switchLanguage(),
    });
    this.verifyCommands(registeredCommands);

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("beeCode")) return;
        const read = readConfig();
        this.config = read.config;
        this.panel.setLocale(this.config.language);
        this.panel.setFontSize(this.config.fontSize);
        for (const problem of read.problems) this.log.warn(`Configuration problem: ${problem}`);
        this.log.info(`Configuration updated: ${describeConfig(this.config)}`);
        if (event.affectsConfiguration("beeCode.ui.language")) {
          this.updateStatus();
          return;
        }

        // Routing: model-only changes → hot reload (no process restart); everything else (core/pythonPath/checkpoint…) → restart
        if ((event.affectsConfiguration("beeCode.model") || event.affectsConfiguration("beeCode.subagent") || event.affectsConfiguration("beeCode.summary")) && this.core) {
          void this.resolveApiKey().then((resolved) => {
            if (!this.core) return undefined;
            const subagent = this.effectiveSubagent();
            return Promise.all([this.resolveSubagentKey(), this.resolveSummaryKey()]).then(([subagentKey, summaryKey]) =>
              this.core
                ? this.core
                    .modelReload({
                      modelConfig: this.config.model,
                      ...(resolved.key ? { apiKey: resolved.key } : {}),
                      subagentConfig: {
                        enabled: subagent.enabled,
                        baseUrl: subagent.baseUrl,
                        model: subagent.model,
                        maxSteps: subagent.maxSteps,
                        supportsVision: subagent.supportsVision,
                      },
                      ...(subagentKey.key ? { subagentApiKey: subagentKey.key } : {}),
                      summaryConfig: this.config.summary,
                      ...(summaryKey.key ? { summaryApiKey: summaryKey.key } : {}),
                    })
                    .catch((err: unknown) =>
                      this.log.warn(`model.reload failed: ${err instanceof Error ? err.message : String(err)}`),
                    )
                : undefined,
            );
          });
          this.updateStatus();
          return;
        }
        void this.restartCore();
      }),
    );

    this.context.subscriptions.push(this.status, this.log, this.diff, this.checkpoint, this.proposals, this.sessions, this.focusHighlight, this.commandTerminal);
    this.updateStatus();
    this.panel.setHint(this.hintForState());
  }

  /**
   * **Ordered** cleanup on shutdown.
   *
   * It only does the one thing subscriptions can't cover: **stop the core in order** (it's a child process and may be running tools).
   * Everything else (panel, commands, listeners, status bar, log, adapters) is registered in `context.subscriptions`
   * and released by VS Code after `deactivate()` returns — a single owner, so nothing is double-disposed.
   *
   * Idempotent: the `disposed` flag ensures repeated calls take effect only once.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    for (const record of this.commandJobs.values()) record.job.kill();
    this.commandJobs.clear();
    // Flush the last few messages to disk first, then stop the core
    await this.sessions.updateStatus(this.sessionId, "idle").catch(() => undefined);
    await this.sessions.flush().catch(() => undefined);

    const core = this.core;
    this.core = undefined;
    if (core) {
      await core.shutdown().catch(() => undefined);
      core.dispose();
    }
    this.log.info("Deactivated");
  }

  // ───────────────────────── Sessions and context ─────────────────────────

  /** First activation: resume the stored sessionId if present, otherwise create a new one */
  private async ensureSession(): Promise<void> {
    const existing = await this.sessions.open(this.sessionId);
    if (existing.length === 0 && !this.sessions.meta(this.sessionId)) {
      this.sessions.create({
        id: this.sessionId,
        title: "New session",
        mode: this.panel.getMode(),
        workspace: workspaceRoots()[0] ?? "",
        createdAt: Date.now(),
      });
    }
    if (existing.length === 0) {
      await this.restoreRetryState();
      this.panel.pushState();
      return;
    }

    this.panel.restore(
      existing.map((m) => ({ id: m.id, role: m.role, text: m.text, ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(m.diagrams ? { diagrams: m.diagrams } : {}) })),
      this.sessions.meta(this.sessionId)?.mode ?? this.panel.getMode(),
    );
    this.persisted = existing.length;
    this.panel.resetReasoning();
    this.log.info(`Session restored: ${existing.length} messages (${this.sessionId})`);
    this.panel.setPlan(this.sessions.meta(this.sessionId)?.plan);
    await this.loadSummary(existing.length);
    await this.refreshTurns();
    await this.refreshTrajectory();

    const meta = this.sessions.meta(this.sessionId);
    const status = meta?.status ?? "idle";   // an unset status is always treated as idle; don't falsely report "interrupted"
    const note = this.interruptionNote(status, meta?.statusDetail);
    if (note) {
      this.panel.addMessage({ id: `sys_${Date.now()}`, role: "system", text: note });
      this.panel.setHint(
        status === "tool"
          ? tr(this.config.language, "上一轮停在工具调用：发「继续上次的操作」即可接着做。", "The previous turn stopped at a tool call. Send \"Continue the previous operation\" to pick up where it left off.")
          : status === "awaiting-decision"
            ? tr(this.config.language, "上次的提案已失效：发「重新生成提案」可以让 agent 再给一次。", "The previous proposal is no longer valid. Send \"Regenerate proposal\" to have the agent produce it again.")
            : tr(this.config.language, "上一轮生成被中断，已作废。", "The previous generation was interrupted and discarded."),
      );
      this.turn = "idle";
      this.turnDetail = undefined;
      await this.sessions.updateStatus(this.sessionId, "idle");
    }
    await this.restoreRetryState();
    this.panel.pushState();
  }

  private interruptionNote(status: TurnStatus, detail?: string): string {
    switch (status) {
      case "thinking":
        return tr(this.config.language, "上一轮在模型生成过程中被重载中断，已作废（不会自动续写）。", "The previous turn was interrupted by a reload during model generation and was discarded (it will not continue automatically).");
      case "tool":
        return tr(this.config.language, `上一轮停在工具调用${detail ? `（${detail}）` : ""}后中断。想接着做，请发送「继续上次的操作」。`, `The previous turn stopped after a tool call${detail ? `（${detail}）` : ""}. To continue, send "Continue the previous operation".`);
      case "awaiting-decision":
        return tr(this.config.language, "上次的待审提案没有保留（重载会清空未决提案）。需要的话发送「重新生成提案」。", "The pending proposal from last time was not kept (a reload clears unresolved proposals). If you still need it, send \"Regenerate proposal\".");
      default:
        return "";
    }
  }

  /** Append a message to disk (user/assistant/system all go through here) */
  private remember(
    role: "user" | "assistant" | "system",
    text: string,
    reasoning?: string | Array<{ round: number; text: string }>,
    diagrams?: DiagramDto[],
    id?: string,
  ): void {
    if (!text.trim() && (!diagrams || diagrams.length === 0)) return;
    this.sessions.append(this.sessionId, {
      id: id ?? `${role[0]}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role,
      text,
      ts: Date.now(),
      ...(reasoning ? { reasoning } : {}),
      ...(diagrams && diagrams.length > 0 ? { diagrams } : {}),
    });
  }

  /**
   * Build the history sent to the model: **not the full transcript**, but the result trimmed by `contextBuilder`.
   *
   * Summary + the most recent N messages verbatim; when over budget, shrink the summary first, then drop the oldest messages.
   */
  private async modelContext(): Promise<{ summary?: string; history: ChatMessage[] }> {
    const all = await this.sessions.open(this.sessionId);
    // Mechanical trimming handles "take the last 8 messages + fallback summary"; the model summary handles "readable summaries of earlier turns"
    const built = buildContext(all, undefined);
    const jobNote = this.activeCommandJobNote();
    const history: ChatMessage[] = [...built.messages];
    if (jobNote) history.push({ role: "system", text: jobNote });
    if (built.folded === 0) return { summary: built.summary, history };

    const summary = await this.modelSummary(all.length);
    return { summary: summary ?? built.summary, history };
  }

  /** Chat rollback: truncate the summary to the "turns still retained" and persist the change */
  private async truncateSummary(messageLine: number): Promise<void> {
    const turns = (await this.turns.list(this.sessionId)).filter((turn) => turn.messageIndex <= messageLine);
    const cache = this.summaryCache;
    if (!cache) return;
    const lines = cache.lines.slice(0, turns.length);
    if (lines.length === 0) {
      this.summaryCache = undefined;
      await this.summaries.remove(this.sessionId);
      return;
    }
    const coveredMessageIndex = turns[turns.length - 1]?.messageIndex ?? 0;
    this.summaryCache = {
      covered: lines.length,
      coveredMessageIndex,
      lines,
      text: tr(this.config.language, `[早前对话摘要 · 模型生成]\n${lines.join("\n")}`, `[Earlier conversation summary · model-generated]\n${lines.join("\n")}`),
    };
    await this.summaries.save(this.sessionId, { covered: lines.length, coveredMessageIndex, lines });
    this.log.info(`Summary truncated with chat rollback to ${lines.length} turns`);
  }

  /** Attachment-limit notices are queued first; several within 250ms merge into one toast + one system message */
  private queueAttachmentNotice(message: string): void {
    if (!this.attachmentNotices.includes(message)) this.attachmentNotices.push(message);
    if (this.attachmentNoticeTimer) clearTimeout(this.attachmentNoticeTimer);

    this.attachmentNoticeTimer = setTimeout(() => this.flushAttachmentNotices(), 250);
  }

  private flushAttachmentNotices(): void {
    if (this.attachmentNoticeTimer) {
      clearTimeout(this.attachmentNoticeTimer);
      this.attachmentNoticeTimer = undefined;
    }
    if (this.attachmentNotices.length === 0) return;
    const notices = [...this.attachmentNotices];
    this.attachmentNotices.length = 0;
    const merged = mergeNotices(notices);
    this.log.warn(`Attachment notice: ${merged}`);
    this.panel.addMessage({
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      role: "system",
      text: merged,
    });
    void vscode.window.showWarningMessage(`Bee Code: ${merged}`);
  }

  /** Load each turn's trace from the turn records (the collapsed card under the user message) */
  private async refreshTurns(): Promise<void> {
    const turns = await this.turns.list(this.sessionId);
    const messages = await this.sessions.open(this.sessionId).catch(() => []);
    const userIds = new Set(messages.filter((m) => m.role === "user").map((m) => m.id));
    const resolveUserId = (turn: (typeof turns)[number]): string | undefined => {
      if (turn.userMessageId && userIds.has(turn.userMessageId)) return turn.userMessageId;
      // Legacy records predate stable userMessageId, or the message id was regenerated: recover by text.
      const prefix = turn.userText.trim().slice(0, 80);
      if (!prefix) return turn.userMessageId;
      return messages.find((m) => m.role === "user" && m.text.startsWith(prefix))?.id ?? turn.userMessageId;
    };
    this.panel.setTurns(
      turns.map((turn) => ({
        userMessageId: resolveUserId(turn),
        status: turn.status ?? "ok",
        error: turn.error,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        elapsedMs: turn.elapsedMs,
        modelWaitMs: turn.modelWaitMs,
        toolMs: turn.toolMs,
        trace: turn.trace,
      })),
    );
  }

  /** Rebuild the right-side trajectory from turn records (used after reload/session switch/rollback) */
  private async refreshTrajectory(): Promise<void> {
    const turns = await this.turns.list(this.sessionId);
    const messages = await this.sessions.open(this.sessionId);
    const items: Array<{ id: string; mode: Mode; intent: string; detail?: string }> = [];
    for (const turn of turns) {
      // Rollback and similar "synthetic turns" have no user message, so keep them out of the trajectory
      if (!turn.userText || turn.userText.trim().length === 0) continue;
      let id = turn.userMessageId;
      if (!id) {
        // Older turn records lack userMessageId: walk back from messageIndex to find the nearest user message
        const start = Math.min(turn.messageIndex - 1, messages.length - 1);
        for (let index = start; index >= 0; index -= 1) {
          const candidate = messages[index];
          if (candidate?.role === "user") {
            id = candidate.id;
            break;
          }
        }
      }
      const detail = formatTurnCost(turn.inputTokens, turn.outputTokens, turn.elapsedMs);
      if (id) items.push({ id, mode: turn.mode, intent: turn.intent, ...(detail ? { detail } : {}) });
    }
    this.panel.setTrajectory(items);
  }

  /** Restore the summary from disk; discard it if the session was truncated externally (avoids summarizing turns that no longer exist) */
  private async loadSummary(totalMessages: number): Promise<void> {
    const stored = await this.summaries.load(this.sessionId);
    if (!stored || stored.lines.length === 0) {
      this.summaryCache = undefined;
      return;
    }
    if (stored.coveredMessageIndex > totalMessages) {
      this.log.warn(`Summary covered ${stored.coveredMessageIndex} messages but the session has ${totalMessages}; discarding stale summary`);
      this.summaryCache = undefined;
      await this.summaries.remove(this.sessionId);
      return;
    }
    const lines = stored.lines.slice(0, stored.covered);
    this.summaryCache = {
      covered: lines.length,
      coveredMessageIndex: stored.coveredMessageIndex,
      lines,
      text: tr(this.config.language, `[早前对话摘要 · 模型生成]\n${lines.join("\n")}`, `[Earlier conversation summary · model-generated]\n${lines.join("\n")}`),
    };
    this.log.info(`Summary restored: ${lines.length} turns (${this.sessionId})`);
  }

  /**
   * Use the model to summarize "folded turns" (incrementally).
   *
   * Only **newly folded** turns are sent to the model, and the result is appended after the existing summary lines,
   * so a longer history doesn't make every summary costlier (O(n²)).
   * On failure, or when the mock core returns empty → fall back to the mechanical summary.
   */
  private async modelSummary(totalMessages: number): Promise<string | undefined> {
    const turns = await this.turns.list(this.sessionId);
    const cutoff = Math.max(0, totalMessages - 8);
    const covered = turns.filter((turn) => turn.messageIndex <= cutoff);
    if (covered.length === 0) return undefined;

    const cached = this.summaryCache;
    if (cached && cached.covered >= covered.length) return cached.text;
    const startIndex = cached ? Math.min(cached.covered, covered.length) : 0;
    const fresh = covered.slice(startIndex);
    if (fresh.length === 0) return cached?.text;

    try {
      const core = this.core ?? (await this.ensureCore());
      const result = await core.contextSummarize({
        turns: fresh.map((turn) => ({
          intent: turn.intent,
          assistant: turn.assistant,
          tools: turn.tools,
          files: turn.files,
          observations: turn.observations,
          ...(turn.diagrams ? { diagrams: turn.diagrams } : {}),
        })),
      });
      const newLines = (result.pairs ?? []).map((pair) => `- ${pair.intent}：${pair.summary}`);
      let text: string | undefined;
      let lines: string[] = [];
      if (newLines.length === fresh.length) {
        lines = [...(cached?.lines ?? []), ...newLines];
        text = tr(this.config.language, `[早前对话摘要 · 模型生成]\n${lines.join("\n")}`, `[Earlier conversation summary · model-generated]\n${lines.join("\n")}`);
      } else if (result.summary.trim()) {
        // The core returned no per-turn results (count mismatch): replace the whole summary and reset the cache to the current coverage
        lines = result.summary.split("\n").filter((line) => line.trim().length > 0);
        text = result.summary;
      }
      if (!text) {
        this.log.debug("Model summary was empty; falling back to mechanical summary");
        return cached?.text;
      }
      const coveredMessageIndex = covered[covered.length - 1]?.messageIndex ?? totalMessages;
      this.summaryCache = { covered: covered.length, coveredMessageIndex, text, lines };
      await this.summaries.save(this.sessionId, {
        covered: covered.length,
        coveredMessageIndex,
        lines,
      });
      this.log.info(`Model summary: ${covered.length} turns total (${fresh.length} new), persisted`);
      return text;
    } catch (err) {
      this.log.warn(`Model summary failed (falling back to mechanical summary): ${err instanceof Error ? err.message : String(err)}`);
    }
    return cached?.text;
  }

  /** At the end of a turn, persist "intent + answer + tools + files" for later intent-based summarization */
  private async appendTurn(userText: string, assistant: string, fallbackMode: Mode): Promise<void> {
    const all = await this.sessions.open(this.sessionId);
    const intent = this.turnIntent?.intent || userText.replace(/\s+/g, " ").trim().slice(0, 120);
    await this.turns.append(this.sessionId, {
      intent,
      mode: this.turnIntent?.mode ?? fallbackMode,
      ...(this.turnIntent?.scale ? { scale: this.turnIntent.scale } : {}),
      ...(typeof this.turnIntent?.needsProposal === "boolean" ? { needsProposal: this.turnIntent.needsProposal } : {}),
      ...(this.turnIntent?.reason ? { reason: this.turnIntent.reason } : {}),
      ...(this.turnUsage
        ? {
            inputTokens: this.turnUsage.inputTokens,
            outputTokens: this.turnUsage.outputTokens,
            elapsedMs: this.turnUsage.elapsedMs,
            modelWaitMs: this.turnUsage.modelWaitMs,
            toolMs: this.turnUsage.toolMs,
          }
        : {}),
      userText: userText.slice(0, 400),
      assistant: assistant.slice(0, 1200),
      tools: [...this.turnTools],
      files: [...this.turnFiles],
      observations: [...this.turnObservations],
      ...(this.turnPlan.length > 0 ? { plan: this.turnPlan } : {}),
      ...(this.turnDiagrams.length > 0 ? { diagrams: [...this.turnDiagrams] } : {}),
      trace: [...this.turnTrace],
      status: this.turnError ? "error" : "ok",
      ...(this.turnError ? { error: this.turnError } : {}),
      ...(this.turnUserMessageId ? { userMessageId: this.turnUserMessageId } : {}),
      ts: Date.now(),
      messageIndex: all.length,
    });
    // The session title follows the "latest user intent", which summarizes the session better than the first message
    if (intent.trim().length > 0) this.sessions.rename(this.sessionId, intent.trim().slice(0, 40));
    this.turnIntent = undefined;
    this.turnTools.clear();
    this.turnObservations.length = 0;
    this.turnDiagrams.length = 0;
    this.turnTrace.length = 0;
    this.turnError = undefined;
    this.turnFiles.clear();
  }

  /** "Continue the previous operation": carry the history so the core can pick up the context */
  private async continueTurn(): Promise<void> {
    await this.send(tr(this.config.language, "继续上次未完成的操作（上一次停在工具调用阶段）。", "Continue the unfinished operation from last time (it stopped at the tool-call stage)."), this.panel.getMode(), []);
  }

  /** "Regenerate proposal": the previous virtual files were lost with memory, so ask the core to produce them again */
  private async regenerateProposal(): Promise<void> {
    await this.send(tr(this.config.language, "请重新生成上一次的改动提案。", "Please regenerate the previous change proposal."), this.panel.getMode(), []);
  }

  /** After a reload/session switch, restore the "previous retry unfinished" state and the pending retry request */
  private async restoreRetryState(): Promise<void> {
    const pending = await this.retries.loadPending(this.sessionId);
    if (!pending) {
      this.lastTurnRequest = undefined;
      this.panel.setRetryAvailable(false);
      return;
    }
    const latest = await this.retries.latest(this.sessionId);
    if (latest?.status === "done" || latest?.status === "cancelled") {
      await this.retries.clearPending(this.sessionId);
      this.lastTurnRequest = undefined;
      this.panel.setRetryAvailable(false);
      return;
    }
    this.lastTurnRequest = {
      text: pending.text,
      mode: pending.mode as Mode,
      attachments: pending.attachments as AttachedContext[],
    };
    this.panel.setRetryAvailable(true);
    if (latest?.status === "waiting" || latest?.status === "starting") {
      this.panel.setHint(tr(this.config.language, "检测到上次模型连接重试在等待/开始时中断，可点「重试本轮」。", "The previous model retry was interrupted; use Retry."));
    } else if (latest?.status === "failed") {
      this.panel.setHint(tr(this.config.language, "检测到上次任务失败，可点「重试本轮」。", "The previous task failed; use Retry."));
    } else {
      this.panel.setHint(tr(this.config.language, "检测到上次任务未完成，可点「重试本轮」。", "The previous task did not finish; use Retry."));
    }
    this.log.info(
      `Restored pending retry (${pending.text.slice(0, 40)}${latest ? `, last status ${latest.status}` : ""})`,
    );
  }

  /** New session: new id, clear the panel, reopen the context */
  private async newSession(): Promise<void> {
    this.autoOpenedProposals.clear();
    await this.diff.closeAll();
    this.killSessionCommandJobs();
    await this.sessions.flush();
    this.sessionId = newSessionId();
    await this.context.globalState.update(SESSION_KEY, this.sessionId);
    this.summaryCache = undefined;
    this.turnIntent = undefined;
    this.turn = "idle";
    this.turnDetail = undefined;
    this.persisted = 0;
    this.panel.restore([], this.panel.getMode());
    this.lastTurnRequest = undefined;
    this.panel.setRetryAvailable(false);
    this.sessions.create({
      id: this.sessionId,
      title: "New session",
      mode: this.panel.getMode(),
      workspace: workspaceRoots()[0] ?? "",
      createdAt: Date.now(),
    });
    this.panel.setHint(tr(this.config.language, "已新建会话。", "New session created."));
  }

  /** Switch to a historical session */
  /** Panel header: model configuration and connection test shortcuts. */
  private async showModelSettings(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: tr(this.config.language, "$(gear) 配置主模型…", "$(gear) Configure main model…"),
          description: tr(this.config.language, "base URL、模型、API Key", "base URL, model, API key"),
          command: "beeCode.model.configure",
        },
        {
          label: tr(this.config.language, "$(check) 测试模型连接", "$(check) Test model connection"),
          command: "beeCode.model.test",
        },
        {
          label: tr(this.config.language, "$(list) 配置摘要模型…", "$(list) Configure summary model…"),
          command: "beeCode.summary.configure",
        },
        {
          label: tr(this.config.language, "$(list) 配置子代理模型…", "$(list) Configure subagent model…"),
          command: "beeCode.subagent.configure",
        },
        {
          label: tr(this.config.language, "$(settings) 打开模型设置", "$(settings) Open model settings"),
          description: "beeCode.model",
          command: "workbench.action.openSettings",
          args: ["beeCode.model"],
        },
        {
          label: tr(this.config.language, "$(trash) 清除 API Key", "$(trash) Clear API key"),
          command: "beeCode.model.clearKey",
        },
      ],
      {
        title: tr(this.config.language, "Bee Code · 模型", "Bee Code · Model"),
        placeHolder: tr(this.config.language, "选择要配置的模型项", "Choose a model setting"),
      },
    );
    if (!picked) return;
    await vscode.commands.executeCommand(picked.command, ...(picked.args ?? []));
  }

  /** Panel header: one button for creating or switching sessions. */
  private async showSessionSwitcher(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: tr(this.config.language, "$(add) 新建会话", "$(add) New session"),
          action: "new" as const,
        },
        {
          label: tr(this.config.language, "$(history) 历史会话…", "$(history) Session history…"),
          action: "history" as const,
        },
      ],
      {
        title: tr(this.config.language, "Bee Code · 会话", "Bee Code · Sessions"),
        placeHolder: tr(this.config.language, "新建会话或切换到历史会话", "Create a new session or switch to history"),
      },
    );
    if (!picked) return;
    if (picked.action === "new") await this.newSession();
    else await this.pickSession();
  }

  private async pickSession(): Promise<void> {
    const metas = this.sessions.list();
    const items = await Promise.all(
      metas.map(async (meta) => {
        const turns = await this.turns.list(meta.id).catch(() => []);
        const tokens = turns.reduce((sum, turn) => sum + (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0), 0);
        const elapsed = turns.reduce((sum, turn) => sum + (turn.elapsedMs ?? 0), 0);
        const cost = formatTurnCost(tokens, 0, elapsed);
        return {
          label: meta.title,
          description: tr(this.config.language, `${new Date(meta.updatedAt).toLocaleString()} · ${meta.messageCount} 条${cost ? ` · ${cost}` : ""}`, `${new Date(meta.updatedAt).toLocaleString()} · ${meta.messageCount} messages${cost ? ` · ${cost}` : ""}`),
          detail: meta.id,
          id: meta.id,
        };
      }),
    );
    if (items.length === 0) {
      void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 还没有历史会话。", "Bee Code: No session history yet."));
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: tr(this.config.language, "Bee Code · 历史会话", "Bee Code · Session History"),
      placeHolder: tr(this.config.language, "选择要恢复的会话", "Select a session to restore"),
    });
    if (!picked || picked.id === this.sessionId) return;
    this.autoOpenedProposals.clear();
    await this.diff.closeAll();

    this.killSessionCommandJobs();
    await this.sessions.flush();
    this.sessionId = picked.id;
    await this.context.globalState.update(SESSION_KEY, this.sessionId);
    this.summaryCache = undefined;
    this.turnIntent = undefined;
    this.persisted = 0;
    const messages = await this.sessions.open(picked.id);
    this.panel.restore(
      messages.map((m) => ({ id: m.id, role: m.role, text: m.text, ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(m.diagrams ? { diagrams: m.diagrams } : {}) })),
      this.sessions.meta(picked.id)?.mode ?? this.panel.getMode(),
    );
    this.persisted = messages.length;
    this.panel.resetReasoning();
    this.panel.setPlan(this.sessions.meta(picked.id)?.plan);
    await this.loadSummary(messages.length);
    await this.refreshTurns();
    await this.refreshTrajectory();
    await this.restoreRetryState();
    this.panel.setHint(tr(this.config.language, `已切换到会话「${picked.label}」（${messages.length} 条消息）。`, `Switched to session "${picked.label}" (${messages.length} messages).`));
    this.panel.pushState();
  }
  // ───────────────────────── Core lifecycle ─────────────────────────

  private async ensureCore(): Promise<CoreApi> {
    if (this.core?.alive) return this.core;
    if (this.starting) return this.starting;
    // After shutdown (including the window where VS Code is still collecting subscriptions after deactivate), never start the core again
    if (this.disposed) throw new Error(tr(this.config.language, "Bee Code 已停用", "Bee Code has been deactivated."));

    this.starting = (async () => {
      let core: CoreApi;
      try {
        core = this.config.coreMode === "mock" ? new MockCore(this.log, () => this.firstWorkspaceFile()) : this.createPythonCore();
      } catch (err) {
        if (err instanceof CoreNotFoundError) {
          // Most common failure in installed mode: the extension directory has no beecode package
          this.panel.setHint(tr(this.config.language, "找不到内核：请在工作区开发 beecode，或设置 beeCode.core.coreRoot", "Core not found: develop beecode in the workspace, or set beeCode.core.coreRoot"));
          this.log.error(err.message);
        }
        throw err;
      }

      core.onNotification((method, params) => this.onCoreNotification(method, params));
      core.onExit((code, reason) => {
        this.core = undefined;
        this.panel.setBusy(false);
        this.busy = false;
        this.panel.addMessage({
          id: `sys_${Date.now()}`,
          role: "system",
          text: tr(this.config.language, `内核已退出（${reason}，code=${code ?? "?"}）。可运行「Bee Code: 重启内核进程」重试。`, `Core exited (${reason}, code=${code ?? "?"}). You can run "Bee Code: Restart Core Process" to retry.`),
        });
        void vscode.window
          .showErrorMessage(`Bee Code: the Python core exited (${reason}).`, "Set up Python", "Show logs")
          .then((choice) => {
            if (choice === "Set up Python") void this.setupPython();
            else if (choice === "Show logs") this.log.showStderr();
          });
        this.updateStatus();
      });

      const resolvedKey = await this.resolveApiKey();
      const subagent = this.effectiveSubagent();
      const subagentKey = await this.resolveSubagentKey();
      const summaryKey = await this.resolveSummaryKey();
      const params: InitializeParams = {
        protocolVersion: PROTOCOL_VERSION,
        workspaceRoots: workspaceRoots(),
        modelConfig: this.config.model,
        maxSteps: this.config.maxSteps,
        toolTimeoutMs: this.config.toolTimeoutMs,
        longToolTimeoutMs: this.config.longToolTimeoutMs,
        largeTaskSteps: this.config.largeTaskSteps,
        maxTurnTokens: this.config.maxTurnTokens,
        maxTurnSeconds: this.config.maxTurnSeconds,
        largeTaskSeconds: this.config.largeTaskSeconds,
        firstTokenSeconds: this.config.firstTokenSeconds,
        idleSeconds: this.config.idleSeconds,
        maxToolCallsPerBatch: this.config.maxToolCallsPerBatch,
        checkpointEnabled: this.config.checkpointEnabled,
        ...(resolvedKey.key ? { apiKey: resolvedKey.key } : {}),
        subagentConfig: {
          enabled: subagent.enabled,
          baseUrl: subagent.baseUrl,
          model: subagent.model,
          maxSteps: subagent.maxSteps,
          supportsVision: subagent.supportsVision,
        },
        ...(subagentKey.key ? { subagentApiKey: subagentKey.key } : {}),
        summaryConfig: this.config.summary,
        ...(summaryKey.key ? { summaryApiKey: summaryKey.key } : {}),
      };

      await core.initialize(params);
      this.core = core;
      this.log.info(`Core ready (${core.kind})`);
      this.updateStatus();
      return core;
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private createPythonCore(): CoreApi {
    // During development the core lives in the workspace; when packaged it lives in the extension directory — let the locator decide, don't hardcode cwd
    const spec = locateCore({
      configuredRoot: this.config.coreRoot,
      configuredArgs: this.config.coreArgs,
      workspaceRoot: workspaceRoots()[0],
      extensionPath: this.context.extensionUri.fsPath,
      cwdOverride: this.config.cwd,
    });

    this.log.info(`Core located: ${describeLaunch(spec)} (PYTHONPATH=${spec.env["PYTHONPATH"] ?? ""})`);
    const interpreter = resolvePython(this.config.pythonPath, this.context.extensionUri.fsPath);
    this.log.info(`Core interpreter: ${interpreter.path} (${interpreter.source})`);
    const core = new PythonCore({
      pythonPath: interpreter.path,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      logger: this.log,
    });
    core.setRequestHandler(this.server.handle);
    return core;
  }

  private async restartCore(): Promise<void> {
    if (this.disposed) return;   // don't start a new process while shutting down
    if (this.core) {
      await this.core.shutdown().catch(() => undefined);
      this.core.dispose();
      this.core = undefined;
    }
    this.panel.addMessage({ id: `sys_${Date.now()}`, role: "system", text: tr(this.config.language, "内核已重启。", "Core restarted.") });
    this.panel.setHint(this.hintForState());
    this.updateStatus();
  }

  /** Stop command jobs still running in the current session (session switch/user stop/shutdown) */
  private killSessionCommandJobs(): void {
    for (const [id, record] of this.commandJobs) {
      if (record.sessionId !== this.sessionId) continue;
      record.cancelled = true;
      record.job.kill();
      this.commandJobs.delete(id);
    }
  }

  private async abort(): Promise<void> {
    this.killSessionCommandJobs();
    const core = this.core;
    if (!core) return;
    await core.abort(this.sessionId).catch((err: unknown) => {
      this.log.warn(`abort failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.busy = false;
    void this.retries.append({
      ts: Date.now(),
      sessionId: this.sessionId,
      status: "cancelled",
      reason: tr(this.config.language, "用户停止", "Stopped by user"),
    });
    await this.retries.clearPending(this.sessionId);
    this.lastTurnRequest = undefined;
    this.panel.setRetryAvailable(false);
    this.panel.setBusy(false);
    this.updateStatus();
  }

  // ───────────────────────── User actions ─────────────────────────

  private async send(text: string, mode: Mode, attachments: AttachedContext[], autoFocus = true): Promise<void> {
    if (this.disposed) return;
    if (this.busy) {
      this.panel.setHint(tr(this.config.language, "上一轮还没结束（可点 ■ 停止）", "The previous turn hasn't finished yet (click ■ to stop)"));
      return;
    }

    // Without a workspace there's no code to read and no checkpoint to write — say so up front instead of letting the core throw ModuleNotFound
    if (isWorkspaceEmpty()) {
      await this.promptOpenWorkspace();
      return;
    }

    const trimmed = text.trim();
    this.focusHighlight.clear();

    // When the user hasn't attached anything manually, automatically attach "the whole function under the cursor" (or N lines above/below when outside a function)
    const clamped = clampAttachments(attachments, this.config.attachments, this.config.language);
    let effectiveAttachments = clamped.items;
    for (const notice of clamped.notices) this.queueAttachmentNotice(notice);
    this.flushAttachmentNotices();
    let focus: FocusInfo | undefined;
    if (autoFocus && attachments.length === 0 && this.config.focus.autoAttach) {
      focus = await readFocusAtCursor({
        fallbackLines: this.config.focus.fallbackLines,
        maxLines: this.config.focus.maxLines,
      }).catch((err: unknown) => {
        this.log.debug(`Failed to read cursor focus: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
      if (focus) {
        effectiveAttachments = [toFocusContext(focus)];
        if (this.config.focus.highlight) this.focusHighlight.show(focus);
        this.log.info(
          `Auto-attached cursor code: ${focus.path}:${focus.startLine}-${focus.endLine} (${focus.kind}${focus.symbol ? ` ${focus.symbol}` : ""})`,
        );
      }
    }

    if (trimmed.length === 0 && effectiveAttachments.length === 0) return;

    const userText = trimmed || defaultInstruction(mode);
    this.lastTurnRequest = { text: userText, mode, attachments: effectiveAttachments };
    const userMessageId = `u_${Date.now()}`;
    this.turnUserMessageId = userMessageId;
    this.panel.addMessage({ id: userMessageId, role: "user", text: userText });
    this.panel.setCost("");
    this.panel.setRetryAvailable(false);
    this.panel.resetReasoning();
    this.turnScale = "small";
    this.turnUsage = undefined;
    this.reasoningSegments.clear();
    this.remember("user", userText, undefined, undefined, userMessageId);
    await this.retries
      .savePending({
        sessionId: this.sessionId,
        text: userText,
        mode,
        attachments: effectiveAttachments,
        savedAt: Date.now(),
      })
      .catch((err: unknown) => this.log.warn(`Failed to save pending retry: ${err instanceof Error ? err.message : String(err)}`));
    this.setBusy(true);
    this.assistantBuffer = "";
    this.turnIntent = undefined;
    this.turnTools.clear();
    this.turnObservations.length = 0;
    this.turnDiagrams.length = 0;
    this.turnTrace.length = 0;
    this.turnError = undefined;
    this.turnFiles.clear();
    this.turnPlan = [];
    this.turn = "thinking";
    this.turnDetail = undefined;
    void this.sessions.updateStatus(this.sessionId, "thinking");

    try {
      const core = await this.ensureCore();
      const meta = this.sessions.meta(this.sessionId);
      // History is **trimmed**: summary + the last N messages, not the full transcript
      const ctx = await this.modelContext();
      const params: ChatSendParams = {
        sessionId: this.sessionId,
        mode,
        text: userText,
        attachments: effectiveAttachments.map(toAttachment),
        ...(focus ? { focus: focusDto(focus) } : {}),
        // This turn's user message is already passed separately via text; don't repeat it in history
        history: stripTrailingUser(ctx.history, userText),
        summary: ctx.summary,
        // Unfinished plan from the previous turn: carried across turns (omitted when everything is done)
        ...(pendingPlan(meta?.plan) ? { plan: pendingPlan(meta?.plan) } : {}),
        ...(meta?.lastIntent ? { lastIntent: meta.lastIntent } : {}),
      };
      await core.chatSend(params);
    } catch (err) {
      this.turnError = err instanceof Error ? err.message : String(err);
      const canRetry = Boolean(this.lastTurnRequest);
      if (canRetry) {
        void this.retries.append({
          ts: Date.now(),
          sessionId: this.sessionId,
          status: "failed",
          reason: this.turnError.slice(0, 500),
        });
      }
      this.panel.setRetryAvailable(canRetry);
      this.panel.addMessage({
        id: `e_${Date.now()}`,
        role: "system",
        text: this.turnError,
      });
    } finally {
      const turnFailed = Boolean(this.turnError);
      const assistantText = this.assistantBuffer;
      if (assistantText.trim()) {
        // Write to the panel state first: pushState re-renders from state, so without this the reply "disappears" when the turn ends
        this.panel.addMessage({ id: `a_${Date.now()}`, role: "assistant", text: assistantText });
        const segments = [...this.reasoningSegments.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([round, text]) => ({ round, text }));
        this.remember("assistant", assistantText, segments.length > 0 ? segments : undefined, this.turnDiagrams);
        this.assistantBuffer = "";
      }
      // Persist the turn record (intent + answer + tools + files) for intent-based summarization during context compression
      await this.appendTurn(userText, assistantText, mode).catch((err: unknown) => {
        this.log.warn(`Failed to write turn record: ${err instanceof Error ? err.message : String(err)}`);
      });
      await this.refreshTurns();
      await this.refreshTrajectory();
      if (!turnFailed) await this.retries.clearPending(this.sessionId);
      this.setBusy(false);
      this.turn = this.proposals.count() > 0 ? "awaiting-decision" : "idle";
      void this.sessions.updateStatus(this.sessionId, this.turn);
      this.panel.pushState();
    }
  }

  /** Retry the previous turn: drop the failed assistant/error, keep the earlier user message, and resend the same request */
  private async retryLastTurn(): Promise<void> {
    if (this.busy || this.disposed) {
      this.panel.setHint(tr(this.config.language, "当前还有任务在跑，先停止再重试。", "A task is still running; stop it before retrying."));
      return;
    }
    const request = this.lastTurnRequest;
    if (!request) {
      this.panel.setHint(tr(this.config.language, "没有可重试的请求。", "Nothing to retry."));
      return;
    }
    const all = await this.sessions.open(this.sessionId);
    let userIndex = -1;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i]?.role === "user") {
        userIndex = i;
        break;
      }
    }
    // Only roll back when the last user message really belongs to this request; otherwise keep the history and let send append a new message
    const canRollback = userIndex >= 0 && all[userIndex]?.text === request.text;
    const truncateAt = canRollback ? userIndex : all.length;
    const kept = await this.sessions.truncate(this.sessionId, truncateAt);
    this.persisted = kept.length;
    if (canRollback) {
      await this.turns.truncate(this.sessionId, truncateAt).catch(() => undefined);
      await this.truncateSummary(truncateAt).catch(() => undefined);
    }
    this.panel.restore(
      kept.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(m.diagrams ? { diagrams: m.diagrams } : {}),
      })),
      this.panel.getMode(),
    );
    this.panel.setRetryAvailable(false);
    this.panel.setHint(tr(this.config.language, "正在重试上一轮…", "Retrying the previous turn…"));
    await this.send(request.text, request.mode, request.attachments, false);
  }

  /** Accept one or more proposals: for each, fetch the body → write to disk → notify the core */
  private async acceptProposals(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const failed: string[] = [];
    for (const id of ids) {
      const result = await this.acceptOne(id);
      if (!result) failed.push(id);
    }
    this.refreshProposals();
    if (failed.length > 0) {
      void vscode.window.showWarningMessage(tr(this.config.language, `Bee Code: ${failed.length} 个提案没能应用（详见输出面板）。`, `Bee Code: ${failed.length} proposals could not be applied (see the output panel for details).`));
    }
  }

  private acceptOne(id: string): Promise<boolean> {
    return this.approvals.run(() => this.acceptOneUnlocked(id));
  }

  private async acceptOneUnlocked(id: string): Promise<boolean> {
    let core: CoreApi;
    try {
      core = await this.ensureCore();
    } catch (err) {
      this.log.error("Failed to accept proposal: core unavailable", err instanceof Error ? err.message : String(err));
      return false;
    }

    const dto = this.proposals.get(id);
    if (!dto || dto.status !== "pending") {
      this.panel.setHint(tr(this.config.language, "提案已失效，请重新生成。", "This proposal is stale; regenerate it."));
      return false;
    }

    // ① Permission gate (the user already clicked "accept", but still deny when a deny rule applies / the workspace isn't trusted)
    try {
      await this.assertWriteAllowed(dto.path, localContext(), { userApproved: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Proposal ${id} denied by permissions: ${message}`);
      void vscode.window.showWarningMessage(`Bee Code: ${message}`);
      return false;
    }

    // ② Automatic snapshot before writing: no longer relies on the core "remembering to call checkpoint"
    if (this.config.checkpointEnabled) {
      const checkpoint = await this.checkpoint.create({ label: `accept ${dto.path}` }).catch(() => undefined);
      if (checkpoint?.id) {
        this.log.debug(`Automatic checkpoint ${checkpoint.id.slice(0, 8)} (${dto.path})`);
        // Snapshot the chat record alongside the code snapshot: rollback can then choose "code + chat together"
        const messages = await this.sessions.open(this.sessionId);
        await this.chatIndex.save(checkpoint.id, this.sessionId, messages.length);
      }
    }

    const result = await this.proposals.accept(
      id,
      async (proposalId) => (await core.proposalRead({ id: proposalId })).text,
      (proposalId, decision) => core.proposalDecide({ id: proposalId, decision }),
    );

    if (result.applied) {
      // The user approved this write: don't leave a dirty editor/save prompt behind.
      try {
        await vscode.workspace.saveAll(false);
      } catch {
        /* saving is best-effort */
      }
      this.log.info(`Proposal applied ${id}`);
      this.panel.planStepDone(dto.path);
      const plan = this.panel.getPlan();
      if (plan) this.sessions.updatePlan(this.sessionId, plan);
      return true;
    }
    this.log.warn(`Proposal not applied ${id} (${dto.path}): ${result.message ?? "unknown reason"}`);
    if (result.conflict) {
      this.proposals.markStale(id);
      void vscode.window.showWarningMessage(
        tr(this.config.language, `Bee Code: ${dto.path} 已被修改，提案未应用。请让 agent 重新生成。`, `Bee Code: ${dto.path} has been modified, so the proposal was not applied. Ask the agent to regenerate it.`),
      );
    }
    return false;
  }

  private rejectProposals(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.approvals.run(() => this.rejectProposalsUnlocked(ids));
  }

  private async rejectProposalsUnlocked(ids: string[]): Promise<void> {
    const core = await this.ensureCore().catch(() => undefined);
    for (const id of ids) {
      await this.proposals.reject(id, async (proposalId, decision) => {
        if (core) await core.proposalDecide({ id: proposalId, decision });
      });
    }
    this.refreshProposals();
  }

  private async acceptAllProposals(): Promise<void> {
    const ids = this.proposals.pending().map((p) => p.id);
    if (ids.length === 0) {
      this.panel.setHint(tr(this.config.language, "没有待处理的提案。", "No pending proposals."));
      return;
    }
    // Accepting in bulk may take a while (each proposal fetches its body + writes to disk): allow canceling midway
    this.acceptAllCancelled = false;
    const token = ++this.acceptAllToken;
    this.panel.setHint(tr(this.config.language, `正在接受 ${ids.length} 个提案…（可运行「取消批量接受」）`, `Accepting ${ids.length} proposals… (you can run "Cancel Bulk Accept")`));
    for (const id of ids) {
      if (this.acceptAllCancelled || token !== this.acceptAllToken) break;
      await this.acceptOne(id);
      this.refreshProposals();
    }
    this.panel.setHint(this.acceptAllCancelled ? tr(this.config.language, "已取消批量接受（已完成的不会回滚）。", "Bulk accept cancelled (already completed items are not rolled back).") : undefined);
    this.refreshProposals();
  }

  /** "Cancel batch accept" command: doesn't interrupt the one currently being written, but stops starting the next */
  private cancelAcceptAll(): void {
    this.acceptAllCancelled = true;
    this.acceptAllToken += 1;
    this.log.info("User cancelled accept-all");
  }

  private async rejectAllProposals(): Promise<void> {
    const ids = this.proposals.pending().map((p) => p.id);
    await this.rejectProposals(ids);
  }

  /** Open a proposal's diff: left = current disk contents, right = proposed contents */
  private async showProposal(id: string): Promise<void> {
    const core = await this.ensureCore().catch(() => undefined);
    if (!core) return;
    const opened = await this.proposals.show(id, async (proposalId) => (await core.proposalRead({ id: proposalId })).text);
    if (!opened) void vscode.window.showWarningMessage(tr(this.config.language, "Bee Code: 无法打开提案预览。", "Bee Code: Could not open the proposal preview."));
  }

  /** The mock proposal points at a file that actually exists; otherwise clicking "view" shows an empty diff */
  private async firstWorkspaceFile(): Promise<string | undefined> {
    const found = await vscode.workspace.findFiles("**/*.{ts,tsx,js,jsx,py,md}", "**/node_modules/**", 1);
    const uri = found[0];
    return uri ? toWorkspaceRelative(uri.fsPath) : undefined;
  }

  // ───────────────────────── Permissions ─────────────────────────

  /** Re-read permission rules and trust state (called at startup + on configuration changes) */
  // ───────────────────────── Sandbox ─────────────────────────

  /**
   * Detect docker at startup; when unavailable, ask **only the first time / when configuration changes**,
   * then run silently under the "no sandbox policy" (avoids a prompt on every startup).
   */
  private async initSandbox(force = false): Promise<void> {
    const detected = await detectDocker();
    this.dockerAvailable = detected;
    const fingerprint = `${this.config.permissions.sandbox}|${this.config.permissions.dockerImage}`;
    const recorded = this.context.globalState.get<{ choice?: "yes" | "no"; fingerprint?: string }>("beeCode.docker");

    if (detected) {
      this.log.info("Docker available: commands run in the sandbox");
      await this.context.globalState.update("beeCode.docker", { choice: "yes", fingerprint });
      if (force || recorded?.choice !== "yes") {
        void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 已检测到 Docker，命令将在沙箱内执行。", "Bee Code: Docker detected; commands will run inside the sandbox."));
      }
      return;
    }

    const askedBefore = recorded?.choice !== undefined && recorded.fingerprint === fingerprint;
    if (askedBefore && !force) {
      this.log.info("Docker unavailable (already reported): running with the no-sandbox policy");
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      tr(this.config.language, "Bee Code: 没有检测到 Docker。\n\n", "Bee Code: Docker was not detected.\n\n") +
        tr(this.config.language, "· 有 Docker：命令在隔离容器内执行，子代理也能执行命令。\n", "· With Docker: commands run in an isolated container, and sub-agents can run commands too.\n") +
        tr(this.config.language, "· 没有 Docker：每条命令都需要你确认；子代理不能执行命令或写文件。", "· Without Docker: every command needs your confirmation; sub-agents cannot run commands or write files."),
      tr(this.config.language, "我有 Docker（重新检测）", "I have Docker (re-detect)"),
      tr(this.config.language, "我没有 Docker", "I don't have Docker"),
      tr(this.config.language, "稍后再说", "Not now"),
    );

    if (choice === tr(this.config.language, "我有 Docker（重新检测）", "I have Docker (re-detect)")) {
      const again = await detectDocker();
      this.dockerAvailable = again;
      if (again) {
        await this.context.globalState.update("beeCode.docker", { choice: "yes", fingerprint });
        void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 已检测到 Docker，命令将在沙箱内执行。", "Bee Code: Docker detected; commands will run inside the sandbox."));
        return;
      }
      void vscode.window.showWarningMessage(tr(this.config.language, "Bee Code: 仍然没有检测到 Docker，按无沙箱策略运行。", "Bee Code: Docker is still not detected; running with the no-sandbox policy."));
    }

    if (choice !== undefined) {
      await this.context.globalState.update("beeCode.docker", {
        choice: choice === tr(this.config.language, "我没有 Docker", "I don't have Docker") ? "no" : undefined,
        fingerprint,
      });
    }
    this.log.info(`Docker unavailable: ${this.dockerAvailable ? "?" : "no-sandbox policy"}`);
  }

  private async redetectSandbox(): Promise<void> {
    await this.initSandbox(true);
  }

  /** Unified policy decision (the pure functions live in policy.ts; this only injects the context) */
  private policyFor(
    action: "read" | "write" | "run",
    opts: { role?: AgentRole; insideWorkspace: boolean; readOnlyCommand?: boolean },
  ): PolicyDecision {
    return decidePolicy({
      trusted: this.trusted,
      dockerAvailable: this.dockerAvailable,
      fullAccess: this.config.permissions.fullAccess,
      role: opts.role ?? "main",
      action,
      insideWorkspace: opts.insideWorkspace,
      readOnlyCommand: opts.readOnlyCommand,
    });
  }

  /** Path outside the workspace: confirm before allowing; once approved, remember the directory in memory (lost on restart) */
  private async ensurePathAccess(rawPath: string, ctx: InboundRequestContext, role: AgentRole): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw deniedError(tr(this.config.language, "未打开工作区", "No workspace open"));
    const absolute = nodePath.isAbsolute(rawPath) ? nodePath.resolve(rawPath) : nodePath.resolve(root, rawPath);
    if (isInside(root, absolute)) return;

    const decision = this.policyFor("read", { role, insideWorkspace: false });
    if (decision.decision === "deny") throw deniedError(decision.reason);

    const answer = await this.confirm.ask(
      {
        question: tr(this.config.language, "允许访问工作区外的路径？", "Allow access to paths outside the workspace?"),
        detail: `${absolute}\n\n${decision.reason}`,
        options: [
          { id: "yes", label: tr(this.config.language, "允许", "Allow") },
          { id: "no", label: tr(this.config.language, "拒绝", "Deny") },
        ],
        rememberKey: `path:${nodePath.dirname(absolute)}`,
      },
      ctx,
    );
    if (answer.choice !== "yes") throw deniedError(tr(this.config.language, "用户拒绝访问工作区外路径", "User denied access to a path outside the workspace"));
    addApprovedRoot(nodePath.dirname(absolute));
  }

  private async refreshPermissions(): Promise<void> {
    this.rules = buildRuleSet(this.config.permissions);
    this.trusted = this.config.permissions.requireTrust
      ? await ensureWorkspaceTrust(this.context, this.log)
      : vscode.workspace.isTrusted;
    this.log.info(
      `Permissions: mode=${this.config.permissions.mode} trusted=${this.trusted} ` +
        `rules(allow=${this.rules.allow.length} ask=${this.rules.ask.length} deny=${this.rules.deny.length})`,
    );
  }

  private describePermission(action: "read" | "write" | "run", target: string): Evaluation {
    return evaluate({
      mode: this.config.permissions.mode,
      rules: this.rules,
      action,
      target,
      trusted: this.trusted,
    });
  }

  /**
   * Write gate.
   *
   * `userApproved` = the user just clicked "accept" on the proposal. It is distinguished to avoid "asking again right after accepting":
   *   - deny → reject (no matter what)
   *   - explicit ask rule → always confirm (the user explicitly asked to be prompted on every write)
   *   - mode defaults to ask → proposal paths count as already confirmed; the core calling edit.apply directly still needs confirmation
   *   - sensitive path + mode allows → confirm once (mode allowance ≠ user awareness)
   */
  /**
   * Write gate.
   *
   * Three layers: sandbox policy (policy.ts) → rule engine (permissions.ts) → second confirmation for sensitive paths.
   * `userApproved` = the user just clicked "accept" on the proposal, used to avoid "asking again right after accepting".
   */
  private async assertWriteAllowed(
    rawPath: string,
    ctx: InboundRequestContext,
    opts: { userApproved: boolean; role?: AgentRole },
  ): Promise<void> {
    const role: AgentRole = opts.role ?? "main";
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw deniedError(tr(this.config.language, "未打开工作区", "No workspace open"));
    const absolute = nodePath.isAbsolute(rawPath) ? nodePath.resolve(rawPath) : nodePath.resolve(root, rawPath);
    const inside = isInside(root, absolute);

    const policy = this.policyFor("write", { role, insideWorkspace: inside });
    if (policy.decision === "deny") throw deniedError(policy.reason);
    if (!inside) await this.ensurePathAccess(rawPath, ctx, role);

    const evaluation = this.describePermission("write", rawPath);
    if (evaluation.decision === "deny") throw deniedError(evaluation.reason);

    const needAsk =
      (policy.decision === "ask" && inside && !opts.userApproved) ||
      (evaluation.decision === "ask" && (evaluation.source === "rule" || !opts.userApproved)) ||
      (evaluation.decision === "allow" &&
        evaluation.source === "mode" &&
        isSensitiveWrite(rawPath) &&
        !opts.userApproved);

    if (!needAsk) return;

    const answer = await this.confirm.ask(
      {
        question: tr(this.config.language, `允许修改 ${rawPath}？`, `Allow modifying ${rawPath}?`),
        detail: tr(this.config.language, `${policy.reason}\n${evaluation.reason}\n\n路径：${rawPath}`, `${policy.reason}\n${evaluation.reason}\n\nPath: ${rawPath}`),
        options: [
          { id: "yes", label: tr(this.config.language, "允许", "Allow") },
          { id: "no", label: tr(this.config.language, "拒绝", "Deny") },
        ],
        rememberKey: `write:${rawPath}`,
      },
      ctx,
    );
    if (answer.choice !== "yes") throw deniedError(tr(this.config.language, "用户拒绝写入", "User denied the write"));
  }

  /**
   * Command execution:
   *   - sandbox request: first approval when Docker is available, optionally allow for the whole session
   *   - host request: dangerous approval every time, justification required
   *   - no docker: read-only allowlist goes through restricted read-only host; write requests go through host approval + checkpoint
   */
  private async runCommand(params: RunParams, ctx: InboundRequestContext): Promise<RunResult> {
    const role: AgentRole = params.role === "subagent" ? "subagent" : "main";
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw deniedError(tr(this.config.language, "未打开工作区", "No workspace open"));

    const ranks = {
      "sandbox-readonly": 0,
      sandbox: 1,
      "sandbox-network": 2,
      host: 3,
    } as const;
    type SandboxLevel = keyof typeof ranks;
    const requested: SandboxLevel =
      params.sandbox === "host"
        ? "host"
        : params.sandbox === "sandbox-network"
          ? "sandbox-network"
          : params.sandbox === "sandbox"
            ? "sandbox"
            : "sandbox-readonly";
    const noDocker = !this.dockerAvailable;
    const hostReadonlyFallback = noDocker && requested === "sandbox-readonly";
    const hostWriteFallback =
      noDocker && requested !== "sandbox-readonly" && requested !== "host";
    if (hostReadonlyFallback && !isHostReadOnlyCommand(params.command)) {
      throw deniedError(
        tr(this.config.language, "没有 Docker：受限只读模式只允许严格白名单内的只读命令（git status/diff/log、ls、rg、cat 等）。", "No Docker: restricted read-only mode only allows read-only commands from a strict allowlist (git status/diff/log, ls, rg, cat, etc.).") +
          tr(this.config.language, "这条命令不在白名单内；如确需执行，请用 sandbox=host 并说明理由。", "This command is not on the allowlist; if you really need to run it, use sandbox=host and explain why."),
      );
    }
    if (requested !== "sandbox-readonly" && !(params.justification ?? "").trim()) {
      throw deniedError(tr(this.config.language, `sandbox=${requested} 必须提供 justification，说明为什么需要额外权限`, `sandbox=${requested} requires a justification explaining why extra permissions are needed`));
    }
    const effectiveParams: RunParams = {
      ...params,
      sandbox: hostReadonlyFallback || hostWriteFallback ? "host" : requested,
    };

    const cwdAbs = params.cwd ? nodePath.resolve(root, params.cwd) : root;
    const inside = isInside(root, cwdAbs);
    const readOnly = noDocker ? isHostReadOnlyCommand(params.command) : isReadOnlyCommand(params.command);

    const policy = this.policyFor("run", { role, insideWorkspace: inside, readOnlyCommand: readOnly });
    if (policy.decision === "deny") throw deniedError(policy.reason);
    if (!inside) await this.ensurePathAccess(params.cwd ?? ".", ctx, role);

    const evaluation = this.describePermission("run", params.command);
    if (evaluation.decision === "deny") throw deniedError(evaluation.reason);

    // Never ask to run a command while file proposals are still undecided: the user must be
    // able to save/reject the edit first, and the command must see the resulting file.
    if (this.proposals.count() > 0) {
      this.panel.setHint(tr(this.config.language, "请先处理待审文件，然后再审批命令。", "Resolve the pending file proposal before approving the command."));
      this.panel.setActivity(tr(this.config.language, "等待文件审批…", "Waiting for file approval…"));
      try {
        await this.proposals.waitForIdle(ctx.signal);
      } catch {
        throw deniedError(tr(this.config.language, "等待文件审批时被取消", "Cancelled while waiting for file approval"));
      }
    }

    let gateHandled = false;
    this.commandTerminal.show();
    this.commandTerminal.writeLine("");
    this.commandTerminal.writeLine(`$ ${params.command}`);
    this.commandTerminal.writeLine(`cwd: ${cwdAbs} · requested: ${requested}`);
    const roleLabel = role === "subagent" ? tr(this.config.language, "子代理", "Sub-agent") : tr(this.config.language, "主 agent", "Main agent");
    const approved = this.sandboxApprovals.get(this.sessionId) ?? -1;
    if (!noDocker && requested !== "host" && ranks[requested] > approved) {
      const labels: Record<SandboxLevel, { question: string; detail: string }> = {
        "sandbox-readonly": {
          question: tr(this.config.language, "允许 agent 在 Docker 只读沙箱内执行命令吗？", "Allow the agent to run commands in a read-only Docker sandbox?"),
          detail: tr(this.config.language, "沙箱：根文件系统只读、工作区只读、无网络、capability 清空、内存/PID 限制。适合查询、构建检查等不需要写文件的命令。", "Sandbox: read-only root filesystem, read-only workspace, no network, all capabilities dropped, memory/PID limits. Suitable for queries, build checks, and other commands that don't need to write files."),
        },
        sandbox: {
          question: tr(this.config.language, "允许 agent 在 Docker 沙箱内写入工作区吗？", "Allow the agent to write to the workspace inside the Docker sandbox?"),
          detail: tr(this.config.language, "额外权限：工作区可写。根文件系统仍只读、无网络；命令可以修改或创建项目文件。", "Extra permission: workspace writable. The root filesystem stays read-only and there is no network; commands can modify or create project files."),
        },
        "sandbox-network": {
          question: tr(this.config.language, "允许 agent 在 Docker 沙箱内访问网络吗？", "Allow the agent to access the network inside the Docker sandbox?"),
          detail: tr(this.config.language, "额外权限：网络访问（Docker bridge）。工作区可写、根只读；可下载依赖、访问外部服务，也可能泄露请求内容。", "Extra permission: network access (Docker bridge). Workspace writable, root read-only; dependencies can be downloaded and external services reached, but request contents may also leak."),
        },
        host: { question: "", detail: "" },
      };
      const spec = labels[requested];
      const answer = await this.confirm.ask(
        {
          question: spec.question,
          detail:
            tr(this.config.language, `${roleLabel} 请求权限：${requested}\n\n`, `${roleLabel} requests permission: ${requested}\n\n`) +
            tr(this.config.language, `命令：${params.command}\n`, `Command: ${params.command}\n`) +
            tr(this.config.language, `目录：${cwdAbs}\n`, `Directory: ${cwdAbs}\n`) +
            tr(this.config.language, `理由：${(params.justification ?? "").trim() || "（未提供）"}\n\n`, `Reason: ${(params.justification ?? "").trim() || "（未提供）"}\n\n`) +
            spec.detail,
          options: [
            { id: "once", label: tr(this.config.language, "仅本次允许", "Allow once") },
            { id: "session", label: tr(this.config.language, "本会话都允许", "Allow for this session") },
            { id: "cancel", label: tr(this.config.language, "取消", "Cancel") },
          ],
        },
        ctx,
      );
      if (answer.choice === "session") {
        this.sandboxApprovals.set(this.sessionId, ranks[requested]);
      } else if (answer.choice !== "once") {
        throw deniedError(tr(this.config.language, "用户取消权限申请", "User declined the permission request"));
      }
      gateHandled = true;
    } else if (hostReadonlyFallback) {
      const fallbackApproved =
        this.hostReadonlyApprovals.has(this.sessionId) ||
        (this.hostFallbackApprovals.get(this.sessionId) ?? -1) >= 1;
      if (!fallbackApproved) {
        const answer = await this.confirm.ask(
          {
            question: tr(this.config.language, "没有 Docker：允许以“受限只读”方式在本机执行命令吗？", "No Docker: allow running this command locally in \"restricted read-only\" mode?"),
            detail:
              tr(this.config.language, `${roleLabel} 请求执行只读命令：

`, `${roleLabel} requests to run a read-only command:

`) +
              tr(this.config.language, `命令：${params.command}
`, `Command: ${params.command}
`) +
              tr(this.config.language, `目录：${cwdAbs}

`, `Directory: ${cwdAbs}

`) +
              tr(this.config.language, "这不是 Docker 沙箱：命令以当前用户权限在本机运行，没有文件系统或网络隔离。\n", "This is not a Docker sandbox: the command runs locally with your current user permissions, with no filesystem or network isolation.\n") +
              tr(this.config.language, "只放行严格白名单中的只读命令（git status/diff/log、ls、rg、cat 等，禁 shell 元字符与可执行子选项）。\n", "Only read-only commands from a strict allowlist are permitted (git status/diff/log, ls, rg, cat, etc.); shell metacharacters and executable sub-options are blocked.\n") +
              tr(this.config.language, "写操作不会走这条路径，会单独要求 host 审批并创建 checkpoint。", "Write operations do not use this path; they require separate host approval and create a checkpoint."),
            options: [
              { id: "once", label: tr(this.config.language, "仅本次允许", "Allow once") },
              { id: "session", label: tr(this.config.language, "本会话都允许", "Allow for this session") },
              { id: "cancel", label: tr(this.config.language, "取消", "Cancel") },
            ],
          },
          ctx,
        );
        if (answer.choice === "session") {
          this.hostReadonlyApprovals.add(this.sessionId);
        } else if (answer.choice !== "once") {
          throw deniedError(tr(this.config.language, "用户取消受限只读执行", "User cancelled the restricted read-only execution"));
        }
      }
      gateHandled = true;
    } else if (hostWriteFallback) {
      const approvedFallback = this.hostFallbackApprovals.get(this.sessionId) ?? -1;
      if (ranks[requested] > approvedFallback) {
        const answer = await this.confirm.ask(
          {
            question: tr(this.config.language, "没有 Docker：允许这条命令以 host 权限执行吗？", "No Docker: allow this command to run with host permissions?"),
            detail:
              tr(this.config.language, `${roleLabel} 请求在 host 上执行写操作：

`, `${roleLabel} requests to run a write operation on the host:

`) +
              tr(this.config.language, `命令：${params.command}
`, `Command: ${params.command}
`) +
              tr(this.config.language, `目录：${cwdAbs}
`, `Directory: ${cwdAbs}
`) +
              tr(this.config.language, `理由：${(params.justification ?? "").trim() || "（未提供）"}

`, `Reason: ${(params.justification ?? "").trim() || "（未提供）"}

`) +
              tr(this.config.language, "没有 Docker，无法提供文件系统或网络隔离。命令将以当前用户权限在真实系统运行，工作区可写、网络可用，可能读取凭据或影响其他项目。\n", "No Docker is available, so no filesystem or network isolation can be provided. The command will run on the real system with your current user permissions: the workspace is writable and the network is available, so it may read credentials or affect other projects.\n") +
              tr(this.config.language, "执行前会创建命令级 checkpoint；checkpoint 只覆盖工作区内的改动，命令仍可能写入工作区外。", "A command-level checkpoint is created before execution; the checkpoint only covers changes inside the workspace, and the command may still write outside it."),
            options: [
              { id: "once", label: tr(this.config.language, "仅本次允许", "Allow once") },
              { id: "session", label: tr(this.config.language, "本会话都允许", "Allow for this session") },
              { id: "cancel", label: tr(this.config.language, "取消", "Cancel") },
            ],
          },
          ctx,
        );
        if (answer.choice === "session") {
          this.hostFallbackApprovals.set(this.sessionId, ranks[requested]);
        } else if (answer.choice !== "once") {
          throw deniedError(tr(this.config.language, "用户取消 host 写回退", "User cancelled the host write fallback"));
        }
      }
      gateHandled = true;
    } else if (requested === "host" && ranks.host > approved) {
      const answer = await this.confirm.ask(
        {
          question: tr(this.config.language, "⚠ 危险：允许 agent 跳出沙箱，在真实系统 Shell 中执行吗？", "⚠ Danger: allow the agent to break out of the sandbox and run in the real system shell?"),
          detail:
            tr(this.config.language, `${roleLabel} 请求在真实环境执行：\n\n`, `${roleLabel} requests to execute in the real environment:\n\n`) +
            tr(this.config.language, `命令：${params.command}\n`, `Command: ${params.command}\n`) +
            tr(this.config.language, `目录：${cwdAbs}\n`, `Directory: ${cwdAbs}\n`) +
            tr(this.config.language, `理由：${(params.justification ?? "").trim() || "（未提供）"}\n\n`, `Reason: ${(params.justification ?? "").trim() || "（未提供）"}\n\n`) +
            (this.dockerAvailable
              ? tr(this.config.language, "危险：这会绕过 Docker 沙箱，命令可以修改真实文件、安装系统软件、访问网络、读取凭据或影响其他项目。\n", "Danger: this bypasses the Docker sandbox. The command can modify real files, install system software, access the network, read credentials, or affect other projects.\n")
              : tr(this.config.language, "危险：当前没有 Docker，真实系统本来就没有沙箱；命令可以修改真实文件、安装系统软件、访问网络、读取凭据或影响其他项目。\n", "Danger: Docker is not available, and the real system has no sandbox to begin with; the command can modify real files, install system software, access the network, read credentials, or affect other projects.\n")) +
            tr(this.config.language, "只在你完全信任这条命令时继续。", "Proceed only if you fully trust this command."),
          options: [
            { id: "once", label: tr(this.config.language, "仅本次执行（危险）", "Run this once (dangerous)") },
            { id: "session", label: tr(this.config.language, "本会话都允许（危险）", "Allow for this session (dangerous)") },
            { id: "cancel", label: tr(this.config.language, "取消", "Cancel") },
          ],
        },
        ctx,
      );
      if (answer.choice === "session") {
        this.sandboxApprovals.set(this.sessionId, ranks.host);
      } else if (answer.choice !== "once") {
        throw deniedError(tr(this.config.language, "用户取消跳出沙箱执行", "User cancelled the sandbox escape execution"));
      }
      gateHandled = true;
    }

    // When a session-level sandbox approval already exists, don't prompt again for ordinary commands
    if (!gateHandled) {
      if (!noDocker && requested !== "host" && ranks[requested] <= approved) gateHandled = true;
      if (requested === "host" && ranks.host <= approved) gateHandled = true;
    }
    const needAsk = !gateHandled && (policy.decision === "ask" || evaluation.decision === "ask");
    if (needAsk) {
      const answer = await this.confirm.ask(
        {
          question: tr(this.config.language, "执行这条命令？", "Run this command?"),
          detail:
            `${policy.reason}\n${evaluation.reason}\n\n` +
            `${params.command}\n\n` +
            tr(this.config.language, `执行环境：${
              requested === "host"
                ? hostReadonlyFallback
                  ? "host 受限只读（非沙箱）"
                  : hostWriteFallback
                    ? "host（无沙箱，工作区可写）"
                    : "真实系统 Shell（危险）"
                : requested === "sandbox-network"
                  ? "Docker 沙箱 + 网络"
                  : requested === "sandbox"
                    ? "Docker 沙箱（工作区可写，无网络）"
                    : this.dockerAvailable
                      ? "Docker 沙箱（只读，无网络）"
                      : "无沙箱（直接执行）"
            }`, `Execution environment: ${
              requested === "host"
                ? hostReadonlyFallback
                  ? "host 受限只读（非沙箱）"
                  : hostWriteFallback
                    ? "host（无沙箱，工作区可写）"
                    : "真实系统 Shell（危险）"
                : requested === "sandbox-network"
                  ? "Docker 沙箱 + 网络"
                  : requested === "sandbox"
                    ? "Docker 沙箱（工作区可写，无网络）"
                    : this.dockerAvailable
                      ? "Docker 沙箱（只读，无网络）"
                      : "无沙箱（直接执行）"
            }`),
          options: [
            { id: "yes", label: tr(this.config.language, "执行", "Run") },
            { id: "no", label: tr(this.config.language, "取消", "Cancel") },
          ],
          // Prompt every time when there's no sandbox (no "remember"); with docker and non-fullAccess, remembering is allowed
          rememberKey: this.dockerAvailable && !this.config.permissions.fullAccess ? `run:${params.command}` : undefined,
        },
        ctx,
      );
      if (answer.choice !== "yes") throw deniedError(tr(this.config.language, "用户取消执行", "User cancelled execution"));
    }

    // A write-capable command invalidates every pending proposal: accepting one afterwards could
    // overwrite a file based on a pre-command snapshot (the classic "run old file" race).
    const writesPossible =
      requested === "host" || hostWriteFallback || (!noDocker && requested !== "sandbox-readonly");
    if (writesPossible) {
      this.proposals.markPendingStale(
        tr(this.config.language, "命令可能修改了文件，请重新生成提案", "A command may have changed files; regenerate this proposal"),
      );
      this.refreshProposals();
    }
    const checkpointId = writesPossible
      ? await this.checkpoint
          .create({ label: `command: ${params.command.slice(0, 80)}` })
          .then((result) => result.id)
          .catch((err: unknown) => {
            this.log.warn(`Command checkpoint creation failed: ${err instanceof Error ? err.message : String(err)}`);
            return "";
          })
      : "";

    const job = await this.runner.start(effectiveParams, ctx);
    this.commandTerminal.writeLine(`sandbox: ${hostReadonlyFallback ? "host-readonly" : job.sandbox}`);
    const record = {
      job,
      sessionId: this.sessionId,
      command: params.command,
      checkpointId,
      sandbox: (hostReadonlyFallback ? "host-readonly" : job.sandbox) as RunResult["sandbox"],
      finalized: false,
      backgrounded: false,
      resultDelivered: false,
      noticeSent: false,
      cancelled: false,
    };
    this.commandJobs.set(job.id, record);
    job.onFinished(() => {
      void this.finalizeCommandJob(record);
      // Give the first wait's result a small window; send the completion notice only if it still hasn't been delivered after that, to avoid duplicates
      setTimeout(() => this.notifyCommandJobFinished(record), 300);
    });
    const yieldMs = Math.max(1_000, Math.min(params.yieldMs ?? 120_000, 300_000));
    const snapshot = await job.wait(yieldMs);
    return await this.commandJobResult(record, snapshot, true);
  }

  /** Turn job state into a model-visible RunResult; while running, keep jobId so command_wait can keep waiting */
  private async commandJobResult(
    record: NonNullable<ReturnType<Shell["commandJobs"]["get"]>>,
    snapshot: CommandJobSnapshot,
    first = false,
  ): Promise<RunResult> {
    const fresh = record.job.readNew();
    if (fresh.finished) {
      record.resultDelivered = true;
      this.commandTerminal.writeResult(fresh.exitCode, fresh.stdout, fresh.stderr, fresh.elapsedMs);
      await this.finalizeCommandJob(record);
      return {
        exitCode: fresh.exitCode,
        stdout: fresh.stdout,
        stderr: fresh.stderr,
        truncated: fresh.truncated,
        durationMs: fresh.elapsedMs,
        sandbox: record.sandbox,
        killed: fresh.killed,
        jobId: record.job.id,
        status: "exited",
        ...(record.backgrounded ? { backgrounded: true, notice: tr(this.config.language, "后台任务已结束。", "The background task has ended.") } : {}),
        hasNewOutput: fresh.stdout.length > 0 || fresh.stderr.length > 0,
        elapsedMs: fresh.elapsedMs,
        ...(fresh.outputAgeMs !== undefined ? { outputAgeMs: fresh.outputAgeMs } : {}),
      };
    }
    record.backgrounded = true;
    const hasNewOutput = fresh.stdout.length > 0 || fresh.stderr.length > 0;
    const progress = hasNewOutput
      ? this.inferCommandProgress(record.command, record.job.tail())
      : "No new output";
    const elapsed = Math.round(snapshot.elapsedMs / 1000);
    return {
      exitCode: null,
      stdout: fresh.stdout,
      stderr: fresh.stderr,
      truncated: fresh.truncated,
      durationMs: snapshot.elapsedMs,
      sandbox: record.sandbox,
      killed: false,
      jobId: record.job.id,
      status: "running",
      backgrounded: true,
      hasNewOutput,
      noNewOutput: !hasNewOutput,
      elapsedMs: snapshot.elapsedMs,
      progress,
      notice: first
        ? `The command has run for ${elapsed}s and moved to the background. Poll with command_wait at your chosen interval, or leave it running; it will not auto-wait.`
        : hasNewOutput
          ? `Background job produced new output; elapsed ${elapsed}s.`
          : `No new output; the job is still running (elapsed ${elapsed}s).`,
      ...(fresh.outputAgeMs !== undefined ? { outputAgeMs: fresh.outputAgeMs } : {}),
    };
  }

  private async finalizeCommandJob(record: NonNullable<ReturnType<Shell["commandJobs"]["get"]>>): Promise<void> {
    if (record.finalized) return;
    if (this.disposed || record.sessionId !== this.sessionId) return;
    record.finalized = true;
    if (!record.checkpointId) return;
    try {
      const files = await this.checkpoint.diff(record.checkpointId);
      if (files.length === 0) return;
      this.commandCheckpoints.set(record.checkpointId, {
        files,
        command: record.command,
        createdAt: Date.now(),
      });
      this.panel.commandCheckpointEvent({
        id: record.checkpointId,
        files,
        command: record.command,
      });
    } catch (err) {
      this.log.warn(`Command change list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private inferCommandProgress(command: string, tail: string): string {
    const text = `${command}\n${tail}`.toLowerCase();
    if (/solving environment|collecting package metadata|parsing|resolving|repodata/.test(text)) {
      return "Resolving environment/dependencies";
    }
    if (/downloading|fetching|download/.test(text)) return "Downloading";
    if (/extracting|installing|unpacking/.test(text)) return "Extracting/installing";
    if (/building|compiling|linking|bundling/.test(text)) return "Building/compiling";
    if (/tests?|test suite|pytest|jest|vitest/.test(text)) return "Running tests";
    const last = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1)[0];
    return last ? `Still running: ${last.slice(0, 160)}` : "Still running (no new output)";
  }

  private async commandWait(params: CommandWaitParams, ctx: InboundRequestContext): Promise<RunResult> {
    const record = this.commandJobs.get(params.jobId);
    if (!record) throw deniedError(tr(this.config.language, "未知或已结束的命令 job；请重新执行命令", "Unknown or already finished command job; please run the command again"));
    if (record.sessionId !== this.sessionId) throw deniedError(tr(this.config.language, "这个命令 job 不属于当前会话", "This command job does not belong to the current session"));
    const yieldMs = Math.max(1_000, Math.min(params.yieldMs ?? 120_000, 300_000));
    const snapshot = await record.job.wait(yieldMs);
    return await this.commandJobResult(record, snapshot);
  }

  private notifyCommandJobFinished(record: NonNullable<ReturnType<Shell["commandJobs"]["get"]>>): void {
    if (record.noticeSent || record.resultDelivered || record.cancelled || !record.backgrounded) return;
    if (this.disposed || record.sessionId !== this.sessionId) return;
    record.noticeSent = true;
    const snap = record.job.peek();
    this.commandTerminal.writeResult(snap.exitCode, snap.stdout, snap.stderr, snap.elapsedMs);
    const exit = snap.exitCode === null ? "unknown" : String(snap.exitCode);
    const text =
      `Background job ${record.job.id} finished (exit ${exit}, elapsed ${Math.round(snap.elapsedMs / 1000)}s). ` +
      "Use command_list to inspect it or command_wait to collect its result.";
    this.panel.addMessage({ id: `bg_${record.job.id}_${Date.now()}`, role: "system", text });
    this.remember("system", text);
  }

  /** Let the model know in later turns which background tasks are still running; don't stuff historical output into the context again */
  private activeCommandJobNote(): string | undefined {
    const lines: string[] = [];
    for (const record of this.commandJobs.values()) {
      if (record.sessionId !== this.sessionId) continue;
      const snap = record.job.peek();
      if (snap.finished) continue;
      const age = snap.outputAgeMs === undefined ? tr(this.config.language, "无", "None") : `${Math.round(snap.outputAgeMs / 1000)}s`;
      lines.push(
        `- ${record.job.id} [${record.sandbox}] running ${Math.round(snap.elapsedMs / 1000)}s, last output ${age}: ${record.command.slice(0, 120)}`,
      );
      if (lines.length >= 8) break;
    }
    if (lines.length === 0) return undefined;
    return (
      "[Background jobs] Commands are still running. Use command_wait(job_id, yield_ms) when you need output; " +
      "no new output returns noNewOutput=true. Use command_terminate when the result is no longer needed.\n" +
      lines.join("\n")
    );
  }

  private async commandList(): Promise<CommandListResult> {
    const jobs: CommandListResult["jobs"] = [];
    for (const record of this.commandJobs.values()) {
      if (record.sessionId !== this.sessionId) continue;
      const snap = record.job.peek();
      jobs.push({
        jobId: record.job.id,
        command: record.command.slice(0, 200),
        status: snap.finished ? "exited" : "running",
        elapsedMs: snap.elapsedMs,
        ...(snap.outputAgeMs !== undefined ? { outputAgeMs: snap.outputAgeMs } : {}),
        sandbox: record.sandbox,
      });
    }
    return { jobs };
  }

  private async commandTerminate(params: CommandTerminateParams): Promise<RunResult> {
    const record = this.commandJobs.get(params.jobId);
    if (!record) throw deniedError(tr(this.config.language, "未知或已结束的命令 job", "Unknown or already finished command job"));
    if (record.sessionId !== this.sessionId) throw deniedError(tr(this.config.language, "这个命令 job 不属于当前会话", "This command job does not belong to the current session"));
    record.job.kill();
    const snapshot = await record.job.wait(5_000);
    return await this.commandJobResult(record, snapshot);
  }

  private async restoreCommandCheckpoint(id: string): Promise<void> {
    const record = this.commandCheckpoints.get(id);
    if (!record) {
      void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 这条命令的检查点已不存在。", "Bee Code: The checkpoint for this command no longer exists."));
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      tr(this.config.language, "撤销这次命令修改吗？", "Undo the changes made by this command?"),
      {
        modal: true,
        detail:
          tr(this.config.language, `命令：${record.command}\n\n`, `Command: ${record.command}\n\n`) +
          tr(this.config.language, `将恢复以下 ${record.files.length} 个文件到命令执行前：\n`, `The following ${record.files.length} files will be restored to their state before the command ran:\n`) +
          record.files.slice(0, 20).join("\n") +
          (record.files.length > 20 ? tr(this.config.language, `\n…还有 ${record.files.length - 20} 个`, `\n…and ${record.files.length - 20} more`) : "") +
          tr(this.config.language, "\n\n只恢复这些文件；命令之外的其他修改不会被动。", "\n\nOnly these files will be restored; other changes outside the command will not be affected."),
      },
      tr(this.config.language, "撤销本次修改", "Undo these changes"),
    );
    if (answer !== tr(this.config.language, "撤销本次修改", "Undo these changes")) return;
    try {
      const restored = await this.checkpoint.restorePaths(id, record.files);
      this.commandCheckpoints.delete(id);
      this.panel.commandCheckpointRestored(id, restored.length);
      this.log.info(`Command restore complete: ${restored.length} files`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(tr(this.config.language, `Bee Code: 撤销失败：${message}`, `Bee Code: Undo failed: ${message}`));
      this.log.error(`Command restore failed: ${message}`);
    }
  }

  /** Clicking the "file already read" chip: open the file and move the cursor to the corresponding line range */
  private async openRead(path: string, startLine?: number, endLine?: number): Promise<void> {
    try {
      const uri = resolveTarget(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });

      if (startLine === undefined) return;
      const start = Math.max(0, Math.min(startLine - 1, doc.lineCount - 1));
      const end = Math.max(start, Math.min((endLine ?? startLine) - 1, doc.lineCount - 1));
      const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      this.log.debug(`Jumped to ${path}:${start + 1}-${end + 1}`);

      // Redraw the highlight after jumping: the panel chip may have existed for a long time, so the live highlight expired long ago.
      // addRead clears itself after 6 seconds and deduplicates (the same range never stacks).
      if (this.config.focus.highlight) {
        this.focusHighlight.addRead({ path, startLine: start + 1, endLine: end + 1 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Failed to open ${path}: ${message}`);
      void vscode.window.showWarningMessage(tr(this.config.language, `Bee Code: 无法打开 ${path}（${message}）`, `Bee Code: Cannot open ${path} (${message})`));
    }
  }
  private async pickFiles(): Promise<void> {
    const found = await vscode.workspace.findFiles("**/*", undefined, 3000);
    const items = found
      .map((uri) => ({ label: toWorkspaceRelative(uri.fsPath), uri }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: tr(this.config.language, "Bee Code · 选择要阅读的文件", "Bee Code · Choose files to read"),
      placeHolder: tr(this.config.language, "输入以筛选；回车确认（可多选）", "Type to filter; press Enter to confirm (multi-select)"),
      matchOnDescription: true,
    });
    if (!picked || picked.length === 0) return;

    for (const item of picked) {
      this.panel.addAttachment({
        path: item.uri.fsPath,
        kind: "file",
        text: "",
      });
    }
    this.panel.reveal();
    this.panel.setHint(tr(this.config.language, `已附加 ${picked.length} 个文件`, `Attached ${picked.length} files`));
  }

  /**
   * Resolve the API key: **SecretStorage first, environment variable as fallback**.
   *
   * Why this order: explicit configuration > environment default. Environment variables suit CI / cases where the key shouldn't go into the credential store;
   * but they're visible to the whole process, so they always come after SecretStorage.
   */
  private async resolveApiKey(): Promise<{ key?: string; source: "secret" | "env" | "none" }> {
    const fromSecret = await this.context.secrets.get(this.config.apiKeyId);
    if (fromSecret) return { key: fromSecret, source: "secret" };
    const fromEnv = process.env[API_KEY_ENV]?.trim();
    if (fromEnv) return { key: fromEnv, source: "env" };
    return { source: "none" };
  }

  /**
   * Resolve the subagent key: SecretStorage (`beeCode.subagent.apiKeyId`) → environment variable → **main agent key**.
   *
   * In most cases the user just wants "the subagent to use a cheaper model but still the same key", so falling back to the main agent at the last level makes sense.
   */
  private async resolveSummaryKey(): Promise<{ key?: string; source: "secret" | "env" | "main" | "none" }> {
    const fromSecret = await this.context.secrets.get(this.config.summary.apiKeyId);
    if (fromSecret) return { key: fromSecret, source: "secret" };
    const fromEnv = process.env[SUMMARY_API_KEY_ENV]?.trim();
    if (fromEnv) return { key: fromEnv, source: "env" };
    const main = await this.resolveApiKey();
    if (main.key) return { key: main.key, source: "main" };
    return { source: "none" };
  }

  private async resolveSubagentKey(): Promise<{ key?: string; source: "secret" | "env" | "main" | "none" }> {
    const fromSecret = await this.context.secrets.get(this.config.subagent.apiKeyId);
    if (fromSecret) return { key: fromSecret, source: "secret" };
    const fromEnv = process.env[SUBAGENT_API_KEY_ENV]?.trim();
    if (fromEnv) return { key: fromEnv, source: "env" };
    const main = await this.resolveApiKey();
    if (main.key) return { key: main.key, source: "main" };
    return { source: "none" };
  }

  /** Effective endpoint/model for the subagent (empty = inherit from the main agent) */
  private effectiveSubagent(): { baseUrl: string; model: string; maxSteps: number; supportsVision: "auto" | "on" | "off"; enabled: boolean } {
    return {
      enabled: this.config.subagent.enabled,
      baseUrl: this.config.subagent.baseUrl.trim() || this.config.model.baseUrl,
      model: this.config.subagent.model.trim() || this.config.model.model,
      maxSteps: this.config.subagent.maxSteps,
      supportsVision: this.config.subagent.supportsVision,
    };
  }

  /** Normalize base_url into `.../models` (used for the connectivity self-check) */
  private modelsUrl(baseUrl: string): string | undefined {
    const base = baseUrl.trim().replace(/\/+$/, "");
    if (!base) return undefined;
    if (base.endsWith("/chat/completions")) return base.replace(/\/chat\/completions$/, "/models");
    if (base.endsWith("/v1")) return `${base}/models`;
    return `${base}/models`;
  }

  /** Test connection: GET {base}/models, translating HTTP status into plain language (shared by main / subagent) */
  private async testModel(which: "main" | "subagent" = "main"): Promise<void> {
    const label = which === "subagent" ? tr(this.config.language, "子代理", "Sub-agent") : tr(this.config.language, "主代理", "Main agent");
    const subagent = this.effectiveSubagent();
    const baseUrl = which === "subagent" ? subagent.baseUrl : this.config.model.baseUrl;
    const modelName = which === "subagent" ? subagent.model : this.config.model.model;
    const url = this.modelsUrl(baseUrl);
    if (!url) {
      void vscode.window.showWarningMessage(tr(this.config.language, `Bee Code: ${label}还没有配置 base_url。`, `Bee Code: ${label} has no base_url configured.`));
      return;
    }
    const keyInfo = which === "subagent" ? await this.resolveSubagentKey() : await this.resolveApiKey();
    if (!keyInfo.key) {
      void vscode.window.showWarningMessage(tr(this.config.language, `Bee Code: ${label}还没有 API Key。`, `Bee Code: ${label} has no API Key yet.`));
      return;
    }
    const key = keyInfo.key;
    const source = keyInfo.source;

    const started = Date.now();
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const elapsed = Date.now() - started;
      if (!response.ok) {
        const body = (await response.text()).slice(0, 200);
        this.log.warn(`${label} self-check failed: HTTP ${response.status} ${url} (key source ${source})`);
        void vscode.window.showWarningMessage(tr(this.config.language, `Bee Code: ${label}连接失败 HTTP ${response.status}（${elapsed}ms）：${body}`, `Bee Code: ${label} connection failed: HTTP ${response.status} (${elapsed}ms): ${body}`));
        return;
      }
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const count = Array.isArray(data.data) ? data.data.length : 0;
      const hasModel = Array.isArray(data.data) && data.data.some((m) => m.id === modelName);
      const sourceText =
        source === "env" ? tr(this.config.language, "环境变量", "Environment variable") : source === "main" ? tr(this.config.language, "沿用主代理", "Use main agent") : tr(this.config.language, "凭据库", "Credentials");
      this.log.info(`${label} self-check passed: ${url} (${count} models, key source ${source})`);
      void vscode.window.showInformationMessage(
        tr(this.config.language, `Bee Code: ${label}连接正常（${elapsed}ms，${count} 个模型${hasModel ? `，包含 ${modelName}` : ""}；key 来源：${sourceText}）`, `Bee Code: ${label} connected (${elapsed}ms, ${count} models${hasModel ? `，包含 ${modelName}` : ""}; key source: ${sourceText})`),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`${label} self-check error: ${message}`);
      void vscode.window.showWarningMessage(tr(this.config.language, `Bee Code: ${label}连接失败：${message}`, `Bee Code: ${label} connection failed: ${message}`));
    }
  }

  /** Configure subagent: endpoint may be left empty (= inherit main agent), key may be left empty (= inherit main agent key) */
  private async configureSubagent(): Promise<void> {
    const main = this.config.model;
    const current = this.config.subagent;

    const baseUrl = await vscode.window.showInputBox({
      title: tr(this.config.language, "Bee Code · 子代理 1/3 端点", "Bee Code · Sub-agent 1/3 Endpoint"),
      prompt: main.baseUrl
        ? tr(this.config.language, `留空 = 沿用主代理（${main.baseUrl}）`, `Leave empty = use the main agent (${main.baseUrl})`)
        : tr(this.config.language, "OpenAI 兼容 base_url；留空 = 沿用主代理", "OpenAI-compatible base_url; leave empty = use the main agent"),
      value: current.baseUrl,
      ignoreFocusOut: true,
    });
    if (baseUrl === undefined) return;

    const model = await vscode.window.showInputBox({
      title: tr(this.config.language, "Bee Code · 子代理 2/3 模型", "Bee Code · Sub-agent 2/3 Model"),
      prompt: main.model ? tr(this.config.language, `留空 = 沿用主代理（${main.model}）；建议用便宜/快的模型`, `Leave empty = use the main agent (${main.model}); a cheaper/faster model is recommended`) : tr(this.config.language, "留空 = 沿用主代理", "Leave empty = use the main agent"),
      value: current.model,
      ignoreFocusOut: true,
    });
    if (model === undefined) return;

    const existing = await this.resolveSubagentKey();
    const keyHint =
      existing.source === "secret"
        ? tr(this.config.language, "已存在于凭据库：直接回车保持不变", "Already in the credentials store: press Enter to keep it")
        : existing.source === "env"
          ? tr(this.config.language, `当前使用环境变量 ${SUBAGENT_API_KEY_ENV}：直接回车保持不变`, `Currently using the environment variable ${SUBAGENT_API_KEY_ENV}: press Enter to keep it`)
          : existing.source === "main"
            ? tr(this.config.language, "留空 = 沿用主代理密钥", "Leave empty = use the main agent's key")
            : tr(this.config.language, "留空则回退到主代理密钥", "Leave empty to fall back to the main agent's key");

    const apiKey = await vscode.window.showInputBox({
      title: tr(this.config.language, "Bee Code · 子代理 3/3 API Key", "Bee Code · Sub-agent 3/3 API Key"),
      prompt: keyHint,
      password: true,
      ignoreFocusOut: true,
      placeHolder: existing.source === "none" ? tr(this.config.language, "留空 = 沿用主代理密钥", "Leave empty = use the main agent's key") : tr(this.config.language, "（回车保持不变）", "(press Enter to keep it)"),
      validateInput: (v) => (v.trim().length > 0 && v.trim().length < 8 ? tr(this.config.language, "看起来不像有效密钥", "This does not look like a valid key") : undefined),
    });
    if (apiKey === undefined) return;

    const cfg = vscode.workspace.getConfiguration("beeCode");
    await cfg.update("subagent.baseUrl", baseUrl.trim(), vscode.ConfigurationTarget.Global);
    await cfg.update("subagent.model", model.trim(), vscode.ConfigurationTarget.Global);
    if (apiKey.trim().length > 0) {
      await this.context.secrets.store(this.config.subagent.apiKeyId, apiKey.trim());
    }

    const read = readConfig();
    this.config = read.config;
    this.log.info(
      `Subagent configured: ${this.effectiveSubagent().model} @ ${this.effectiveSubagent().baseUrl}`,
    );
    void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 子代理配置完成。", "Bee Code: Sub-agent configuration complete."));

    // Configuration listeners don't fire when only the key changed, so trigger a hot reload here
    const sub = this.effectiveSubagent();
    const [mainKey, subKey] = await Promise.all([this.resolveApiKey(), this.resolveSubagentKey()]);
    await this.core
      ?.modelReload({
        modelConfig: this.config.model,
        ...(mainKey.key ? { apiKey: mainKey.key } : {}),
        subagentConfig: {
          enabled: sub.enabled,
          baseUrl: sub.baseUrl,
          model: sub.model,
          maxSteps: sub.maxSteps,
          supportsVision: sub.supportsVision,
        },
        ...(subKey.key ? { subagentApiKey: subKey.key } : {}),
      })
      .catch(() => undefined);
  }

  /** Configure summary model: endpoint → model → key → test and save (empty = inherit main model) */
  private async configureSummary(): Promise<void> {
    const main = this.config.model;
    const current = this.config.summary;

    const baseUrl = await vscode.window.showInputBox({
      title: tr(this.config.language, "Bee Code · 摘要模型 1/3 端点", "Bee Code · Summary model 1/3 Endpoint"),
      prompt: main.baseUrl
        ? tr(this.config.language, `留空 = 沿用主模型（${main.baseUrl}）`, `Leave empty = use the main model (${main.baseUrl})`)
        : tr(this.config.language, "OpenAI 兼容 base_url；留空 = 沿用主模型", "OpenAI-compatible base_url; leave empty = use the main model"),
      value: current.baseUrl,
      ignoreFocusOut: true,
    });
    if (baseUrl === undefined) return;

    const model = await vscode.window.showInputBox({
      title: tr(this.config.language, "Bee Code · 摘要模型 2/3 模型", "Bee Code · Summary model 2/3 Model"),
      prompt: main.model
        ? tr(this.config.language, `留空 = 沿用主模型（${main.model}）；建议用便宜/快的模型`, `Leave empty = use the main model (${main.model}); a cheaper/faster model is recommended`)
        : tr(this.config.language, "留空 = 沿用主模型", "Leave empty = use the main model"),
      value: current.model,
      ignoreFocusOut: true,
    });
    if (model === undefined) return;

    const existing = await this.resolveSummaryKey();
    const keyHint =
      existing.source === "secret"
        ? tr(this.config.language, "已存在于凭据库：直接回车保持不变", "Already in the credentials store: press Enter to keep it")
        : existing.source === "env"
          ? tr(this.config.language, `当前使用环境变量 ${SUMMARY_API_KEY_ENV}：直接回车保持不变`, `Currently using the environment variable ${SUMMARY_API_KEY_ENV}: press Enter to keep it`)
          : existing.source === "main"
            ? tr(this.config.language, "留空 = 沿用主模型密钥", "Leave empty = use the main model's key")
            : tr(this.config.language, "留空则回退到主模型密钥", "Leave empty to fall back to the main model's key");
    const apiKey = await vscode.window.showInputBox({
      title: tr(this.config.language, "Bee Code · 摘要模型 3/3 API Key", "Bee Code · Summary model 3/3 API Key"),
      prompt: keyHint,
      password: true,
      ignoreFocusOut: true,
      placeHolder: existing.source === "none" ? tr(this.config.language, "留空 = 沿用主模型密钥", "Leave empty = use the main model's key") : tr(this.config.language, "（回车保持不变）", "(press Enter to keep it)"),
      validateInput: (v) => (v.trim().length > 0 && v.trim().length < 8 ? tr(this.config.language, "看起来不像有效密钥", "This does not look like a valid key") : undefined),
    });
    if (apiKey === undefined) return;

    const effectiveBase = baseUrl.trim() || main.baseUrl;
    const effectiveModel = model.trim() || main.model;
    const testKey = apiKey.trim().length > 0 ? apiKey.trim() : existing.key;
    const probe = await this.probeModels(effectiveBase, effectiveModel, testKey);
    if (!probe.ok) {
      const choice = await vscode.window.showWarningMessage(
        tr(this.config.language, `摘要模型连接测试失败：${probe.message}\n仍然保存配置吗？`, `Summary model connection test failed: ${probe.message}\nSave the configuration anyway?`),
        { modal: true },
        tr(this.config.language, "仍然保存", "Save anyway"),
      );
      if (choice !== tr(this.config.language, "仍然保存", "Save anyway")) return;
    }

    const cfg = vscode.workspace.getConfiguration("beeCode");
    await cfg.update("summary.baseUrl", baseUrl.trim(), vscode.ConfigurationTarget.Global);
    await cfg.update("summary.model", model.trim(), vscode.ConfigurationTarget.Global);
    if (apiKey.trim().length > 0) {
      await this.context.secrets.store(this.config.summary.apiKeyId, apiKey.trim());
    }

    this.config = readConfig().config;
    this.log.info(
      `Summary model configured: ${this.config.summary.model || "(inherit main)"} @ ${this.config.summary.baseUrl || "(inherit main)"}`,
    );
    void vscode.window.showInformationMessage(
      tr(this.config.language, `Bee Code: 摘要模型配置完成${probe.ok ? `（${probe.message}）` : ""}。`, `Bee Code: Summary model configuration complete${probe.ok ? ` (${probe.message})` : ""}.`),
    );

    // Configuration listeners don't fire when only the key changed, so trigger a hot reload here
    const sub = this.effectiveSubagent();
    const [mainKey, subKey, summaryKey] = await Promise.all([
      this.resolveApiKey(),
      this.resolveSubagentKey(),
      this.resolveSummaryKey(),
    ]);
    await this.core
      ?.modelReload({
        modelConfig: this.config.model,
        ...(mainKey.key ? { apiKey: mainKey.key } : {}),
        subagentConfig: {
          enabled: sub.enabled,
          baseUrl: sub.baseUrl,
          model: sub.model,
          maxSteps: sub.maxSteps,
          supportsVision: sub.supportsVision,
        },
        ...(subKey.key ? { subagentApiKey: subKey.key } : {}),
        summaryConfig: this.config.summary,
        ...(summaryKey.key ? { summaryApiKey: summaryKey.key } : {}),
      })
      .catch(() => undefined);
  }

  /** GET /models for a connectivity/model self-check; no need to actually send a chat request */
  private async probeModels(
    baseUrl: string,
    model: string,
    key: string | undefined,
  ): Promise<{ ok: boolean; message: string }> {
    const url = this.modelsUrl(baseUrl);
    if (!url) return { ok: false, message: tr(this.config.language, "没有配置 base_url", "No base_url configured") };
    if (!key) return { ok: false, message: tr(this.config.language, "没有可用的 API Key", "No API Key available") };
    const started = Date.now();
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      const elapsed = Date.now() - started;
      if (!response.ok) {
        const body = (await response.text()).slice(0, 160);
        return { ok: false, message: `HTTP ${response.status}（${elapsed}ms）：${body}` };
      }
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = Array.isArray(data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
      const hasModel = model ? ids.includes(model) : true;
      return {
        ok: hasModel,
        message: hasModel
          ? tr(this.config.language, `连接正常（${elapsed}ms，${ids.length} 个模型）`, `Connected (${elapsed}ms, ${ids.length} models)`)
          : tr(this.config.language, `连接正常，但模型列表里没有 ${model}`, `Connected, but ${model} is not in the model list`),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }

  /** Clear the subagent key (environment variables and "inherit main agent" aren't ours to manage) */
  private async clearSubagentKey(): Promise<void> {
    const existing = await this.context.secrets.get(this.config.subagent.apiKeyId);
    if (!existing) {
      void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 凭据库里没有子代理密钥（可能在环境变量里，或沿用了主代理）。", "Bee Code: There is no sub-agent key in the credentials store (it may be in an environment variable, or the main agent's key is being used)."));
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      tr(this.config.language, "确定清除子代理的 API Key？清除后将回退到环境变量或主代理密钥。", "Clear the sub-agent API Key? After clearing, it will fall back to the environment variable or the main agent's key."),
      { modal: true },
      tr(this.config.language, "清除", "Clear"),
    );
    if (confirm !== tr(this.config.language, "清除", "Clear")) return;
    await this.context.secrets.delete(this.config.subagent.apiKeyId);
    this.log.info("Subagent API key cleared");
    void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 已清除子代理 API Key。", "Bee Code: Sub-agent API Key cleared."));
  }

  /** Clear the key in the credential store (environment variables aren't ours to manage) */
  private async clearModelKey(): Promise<void> {
    const existing = await this.context.secrets.get(this.config.apiKeyId);
    if (!existing) {
      void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 凭据库里没有密钥（可能在环境变量里）。", "Bee Code: There is no key in the credentials store (it may be in an environment variable)."));
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      tr(this.config.language, "确定清除凭据库里保存的 API Key？清掉后需要重新配置（或改用环境变量）。", "Clear the API Key saved in the credentials store? After clearing it you will need to configure it again (or switch to an environment variable)."),
      { modal: true },
      tr(this.config.language, "清除", "Clear"),
    );
    if (confirm !== tr(this.config.language, "清除", "Clear")) return;
    await this.context.secrets.delete(this.config.apiKeyId);
    this.log.info("API key cleared from the credential store");
    void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 已清除 API Key。", "Bee Code: API Key cleared."));
  }

  private async configureModel(): Promise<void> {
    const baseUrl = await vscode.window.showInputBox({
      title: tr(this.config.language, "Bee Code · 1/3 端点", "Bee Code · 1/3 Endpoint"),
      prompt: tr(this.config.language, "OpenAI 兼容 base_url（不含 /chat/completions）", "OpenAI-compatible base_url (without /chat/completions)"),
      value: this.config.model.baseUrl || "https://api.deepseek.com/v1",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length === 0 ? tr(this.config.language, "不能为空", "Cannot be empty") : undefined),
    });
    if (baseUrl === undefined) return;

    const model = await vscode.window.showInputBox({
      title: tr(this.config.language, "Bee Code · 2/3 模型", "Bee Code · 2/3 Model"),
      prompt: tr(this.config.language, "模型名，例如 deepseek-chat", "Model name, e.g. deepseek-chat"),
      value: this.config.model.model || "",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length === 0 ? tr(this.config.language, "不能为空", "Cannot be empty") : undefined),
    });
    if (model === undefined) return;

    // If already configured, allow "press Enter to keep it unchanged" — retyping the key every time the endpoint changes is tedious
    const existing = await this.resolveApiKey();
    const keyHint =
      existing.source === "secret"
        ? tr(this.config.language, "已存在于凭据库：直接回车保持不变", "Already in the credentials store: press Enter to keep it")
        : existing.source === "env"
          ? tr(this.config.language, `当前使用环境变量 ${API_KEY_ENV}：直接回车保持不变`, `Currently using the environment variable ${API_KEY_ENV}: press Enter to keep it`)
          : tr(this.config.language, "仅存入 VS Code SecretStorage（OS 凭据库），不会写入 settings.json / 日志 / git", "Stored only in VS Code SecretStorage (the OS credentials store); never written to settings.json, logs, or git");

    const apiKey = await vscode.window.showInputBox({
      title: "Bee Code · 3/3 API Key",
      prompt: keyHint,
      password: true,
      ignoreFocusOut: true,
      placeHolder: existing.source === "none" ? tr(this.config.language, "粘贴你的 API Key", "Paste your API Key") : tr(this.config.language, "（回车保持不变）", "(press Enter to keep it)"),
      validateInput: (v) => {
        const trimmed = v.trim();
        if (trimmed.length === 0) return existing.source === "none" ? tr(this.config.language, "不能为空", "Cannot be empty") : undefined;
        return trimmed.length < 8 ? tr(this.config.language, "看起来不像有效密钥", "This does not look like a valid key") : undefined;
      },
    });
    if (apiKey === undefined) return;

    const typedKey = apiKey.trim();
    if (typedKey.length > 0) {
      await this.context.secrets.store(this.config.apiKeyId, typedKey);
    }
    const cfg = vscode.workspace.getConfiguration("beeCode");
    await cfg.update("model.baseUrl", baseUrl.trim(), vscode.ConfigurationTarget.Global);
    await cfg.update("model.model", model.trim(), vscode.ConfigurationTarget.Global);

    const read = readConfig();
    this.config = read.config;
    for (const problem of read.problems) this.log.warn(`Configuration problem: ${problem}`);
    this.log.info(`Model configured: ${this.config.model.model} @ ${this.config.model.baseUrl} (key stored)`);
    void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 模型配置完成。", "Bee Code: Model configuration complete."));

    // Configuration-change listeners trigger modelReload (no process restart), so don't call it again here
    const resolved = await this.resolveApiKey();
    if (this.core && resolved.key) {
      await this.core
        .modelReload({ modelConfig: this.config.model, apiKey: resolved.key })
        .catch(() => undefined);
    }
  }

  /**
   * Roll back to a checkpoint.
   *
   * Two semantics (the user chooses):
   *   - Code only: files return to the snapshot, chat is kept, and **a rollback notice is appended** so the model knows
   *   - Code + chat: files and conversation both return to the snapshot moment (JSONL truncated)
   *
   * Both invalidate snapshots after the target (rewind the shadow repository HEAD + delete the corresponding chat snapshots),
   * and new snapshots continue from the target point.
   */
  private async restoreCheckpoint(): Promise<void> {
    const records = await this.checkpoint.list();
    if (records.length === 0) {
      void vscode.window.showInformationMessage(tr(this.config.language, "Bee Code: 还没有检查点（写入前会自动创建）。", "Bee Code: No checkpoints yet (one is created automatically before writing)."));
      return;
    }
    const snapshots = new Map((await this.chatIndex.list()).map((meta) => [meta.id, meta]));

    const items = records.map((record) => {
      const snap = snapshots.get(record.id);
      return {
        label: record.id.slice(0, 8),
        description: new Date(record.createdAt).toLocaleString(),
        detail: `${record.label}${snap ? ` · with chat snapshot (line ${snap.line})` : " · no chat snapshot"}`,
        id: record.id,
        hasChat: Boolean(snap),
        line: snap?.line ?? 0,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: tr(this.config.language, "Bee Code · 恢复到检查点", "Bee Code · Restore to Checkpoint"),
      placeHolder: tr(this.config.language, "选择要回滚到的快照", "Choose the snapshot to roll back to"),
    });
    if (!picked) return;

    const modePick = await vscode.window.showQuickPick(
      [
        {
          label: tr(this.config.language, "仅回滚代码", "Roll back code only"),
          description: tr(this.config.language, "保留当前聊天记录；模型会收到一条「代码已回滚」的通知", "Keep the current chat history; the model will receive a notice that the code was rolled back"),
          value: "code" as const,
        },
        {
          label: tr(this.config.language, "代码 + 聊天记录一起回滚", "Roll back code + chat history together"),
          description: picked.hasChat
            ? tr(this.config.language, `对话回到快照时刻（第 ${picked.line} 行之前的记录）`, `Conversation returns to the snapshot moment (records from before line ${picked.line})`)
            : tr(this.config.language, "该检查点没有聊天快照，只能回滚代码", "This checkpoint has no chat snapshot, so only the code can be rolled back"),
          value: "chat" as const,
          disabled: !picked.hasChat,
        },
      ],
      { title: tr(this.config.language, "回滚范围", "Rollback scope"), placeHolder: tr(this.config.language, "代码和聊天记录要不要一起回退？", "Roll back code and chat history together?") },
    );
    if (!modePick) return;
    const restoreChat = modePick.value === "chat";

    const confirm = await vscode.window.showWarningMessage(
      restoreChat
        ? tr(this.config.language, "将覆盖当前工作区文件，并把聊天记录截断到该快照时刻。目标之后的所有快照会作废。继续？", "This will overwrite files in the current workspace and truncate the chat history to that snapshot moment. All snapshots after the target will be discarded. Continue?")
        : tr(this.config.language, "将覆盖当前工作区文件（包括你自己的未提交修改）。目标之后的所有快照会作废。继续？", "This will overwrite files in the current workspace (including your own uncommitted changes). All snapshots after the target will be discarded. Continue?"),
      { modal: true },
      tr(this.config.language, "回滚", "Roll back"),
    );
    if (confirm !== tr(this.config.language, "回滚", "Roll back")) return;

    const result = await this.checkpoint.restore({ id: picked.id });
    const { voided } = await this.checkpoint.rewind(picked.id);
    await this.chatIndex.remove(voided);
    this.log.info(
      `Rolled back to ${picked.id.slice(0, 8)}: restored ${result.restored.length} files, invalidated ${voided.length} later snapshots`,
    );

    // Pending proposals after a rollback are necessarily based on the old code, so clear them to avoid accidentally clicking "accept"
    this.proposals.clear();
    this.panel.setProposals(this.proposals.visible());

    if (restoreChat) {
      const snapshot = await this.chatIndex.load(picked.id);
      if (!snapshot || snapshot.sessionId !== this.sessionId) {
        void vscode.window.showWarningMessage(tr(this.config.language, "Bee Code: 聊天快照不可用（可能属于别的会话），本次只回滚了代码。", "Bee Code: Chat snapshot unavailable (it may belong to another session); only the code was rolled back this time."));
        await this.noteRollback(picked.id, picked.label, false);
        return;
      }
      // Snapshots store only the line number: truncate the JSONL to that line; the full message text still exists only once
      const kept = await this.sessions.truncate(this.sessionId, snapshot.line);
      this.panel.restore(
        kept.map((m) => ({ id: m.id, role: m.role, text: m.text, ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(m.diagrams ? { diagrams: m.diagrams } : {}) })),
        this.sessions.meta(this.sessionId)?.mode,
      );
      this.persisted = kept.length;
      // Truncate the turn records to the same point; the summary follows (covered turns align by messageIndex)
      await this.turns.truncate(this.sessionId, snapshot.line);
      await this.truncateSummary(snapshot.line);
      await this.retries.clearPending(this.sessionId);
      this.lastTurnRequest = undefined;
      this.panel.setRetryAvailable(false);
      const keptTurns = await this.turns.list(this.sessionId);
      const lastTurn = keptTurns[keptTurns.length - 1];
      this.sessions.updateLastIntent(
        this.sessionId,
        lastTurn
          ? {
              mode: lastTurn.mode,
              intent: lastTurn.intent,
              ...(lastTurn.scale ? { scale: lastTurn.scale } : {}),
              ...(typeof lastTurn.needsProposal === "boolean" ? { needsProposal: lastTurn.needsProposal } : {}),
              ...(lastTurn.reason ? { reason: lastTurn.reason } : {}),
            }
          : undefined,
      );
      const lastPlan = lastTurn?.plan;
      this.panel.setPlan(lastPlan);
      this.sessions.updatePlan(this.sessionId, lastPlan);
      await this.refreshTurns();
      await this.refreshTrajectory();
      this.turnIntent = undefined;
      void this.sessions.updateStatus(this.sessionId, "idle");
      const intentNote = lastTurn
        ? tr(this.config.language, `意图已回退到「${lastTurn.intent}」（${lastTurn.mode}${lastTurn.scale ? ` · ${lastTurn.scale === "large" ? "大任务" : "小任务"}` : ""}）。`, `Intent rolled back to "${lastTurn.intent}" (${lastTurn.mode}${lastTurn.scale ? ` · ${lastTurn.scale === "large" ? "大任务" : "小任务"}` : ""}).`)
        : tr(this.config.language, "意图已清空（没有保留的轮次）。", "Intent cleared (no turns were kept).");
      await this.noteRollback(picked.id, picked.label, true, intentNote);
      void vscode.window.showInformationMessage(
        tr(this.config.language, `Bee Code: 已回滚代码与聊天记录（截断到第 ${snapshot.line} 行，恢复 ${result.restored.length} 个文件）。`, `Bee Code: Rolled back code and chat history (truncated to line ${snapshot.line}, restored ${result.restored.length} files).`),
      );
      return;
    }

    await this.noteRollback(picked.id, picked.label, false);
    void vscode.window.showInformationMessage(
      tr(this.config.language, `Bee Code: 已回滚 ${result.restored.length} 个文件（聊天记录保留）。`, `Bee Code: Rolled back ${result.restored.length} files (chat history kept).`),
    );
  }
  /** After a rollback, write a system message and record it as a turn "intent" so later summaries cover this rollback */
  private async noteRollback(
    checkpointId: string,
    label: string,
    withChat: boolean,
    intentNote?: string,
  ): Promise<void> {
    const base = withChat
      ? tr(this.config.language, `【回滚通知】已把代码与聊天记录一起回滚到检查点 ${checkpointId.slice(0, 8)}（${label}）。此前的对话记录已截断，请以当前文件内容为准。`, `[Rollback notice] Code and chat history were rolled back together to checkpoint ${checkpointId.slice(0, 8)} (${label}). Earlier conversation records have been truncated; rely on the current file contents.`)
      : tr(this.config.language, `【回滚通知】代码已回滚到检查点 ${checkpointId.slice(0, 8)}（${label}），聊天记录保留。`, `[Rollback notice] Code was rolled back to checkpoint ${checkpointId.slice(0, 8)} (${label}); chat history was kept.`) +
        tr(this.config.language, "此前提到的文件改动可能已不在磁盘上；请以当前文件内容为准，需要时重新读取确认。", "File changes mentioned earlier may no longer be on disk; rely on the current file contents and re-read them if needed.");
    const text = intentNote ? `${base} ${intentNote}` : base;
    this.panel.addMessage({ id: `sys_${Date.now()}`, role: "system", text });
    this.remember("system", text);
    const all = await this.sessions.open(this.sessionId);
    await this.turns.append(this.sessionId, {
      intent: tr(this.config.language, `把代码回滚到检查点 ${checkpointId.slice(0, 8)}${withChat ? "（含聊天记录）" : ""}`, `Roll code back to checkpoint ${checkpointId.slice(0, 8)}${withChat ? "（含聊天记录）" : ""}`),
      mode: this.panel.getMode(),
      userText: "",
      assistant: text,
      tools: [],
      files: [],
      observations: [],
      ts: Date.now(),
      messageIndex: all.length,
    });
    this.log.info(`Rollback notice written to session (${withChat ? "with chat rollback" : "code only"})`);
  }
  /**
   * Export a diagnostics bundle (already redacted).
   *
   * Destination: `<globalStorage>/diagnostics/` — an extension-private directory that won't be committed to git by mistake,
   * and doesn't create files in the user's workspace. Users can "Save as…" to the desktop/documents when filing an issue.
   */
  // ── Skills & MCP library ─────────────────────────────────────────────────

  private libraryRoot(): string | undefined {
    const roots = workspaceRoots();
    return roots.length ? nodePath.join(roots[0]!, ".beecode") : undefined;
  }

  private async refreshLibrary(): Promise<void> {
    const base = this.libraryRoot();
    if (!base) {
      this.libraryView?.postState({ skills: [], mcp: [] });
      return;
    }
    const state: LibraryState = { skills: [], mcp: [] };
    const skillsDir = vscode.Uri.file(nodePath.join(base, "skills"));
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(skillsDir)) {
        if (type !== vscode.FileType.Directory) continue;
        const file = vscode.Uri.file(nodePath.join(base, "skills", name, "SKILL.md"));
        let text = "";
        try { text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8"); } catch { continue; }
        const descMatch = text.match(/^description:\s*(.+)$/im);
        const firstLine = text.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? name;
        state.skills.push({ name, description: (descMatch?.[1] ?? firstLine).slice(0, 160), path: file.fsPath });
      }
    } catch { /* no skills directory yet */ }
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(nodePath.join(base, "mcp.json")))).toString("utf8");
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command?: string; args?: string[] }>; servers?: Record<string, { command?: string; args?: string[] }> };
      for (const [name, spec] of Object.entries(parsed.mcpServers ?? parsed.servers ?? {})) {
        state.mcp.push({ name, command: String(spec.command ?? ""), args: Array.isArray(spec.args) ? spec.args.map(String) : [] });
      }
    } catch { /* no mcp config yet */ }
    this.libraryView?.postState(state);
  }

  private async addLibraryUris(uris: string[]): Promise<void> {
    const base = this.libraryRoot();
    if (!base) return;
    for (const raw of uris) {
      let uri: vscode.Uri;
      try { uri = vscode.Uri.parse(raw); } catch { continue; }
      if (uri.scheme !== "file") continue;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          const target = vscode.Uri.file(nodePath.join(base, "skills", this.skillSlug(nodePath.basename(uri.fsPath))));
          await vscode.workspace.fs.createDirectory(target);
          await this.copyDirectory(uri, target);
        } else if (nodePath.basename(uri.fsPath).toLowerCase() === "mcp.json") {
          await this.addMcpFile([{ name: uri.fsPath, text: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8") }]);
        } else if (nodePath.basename(uri.fsPath).toLowerCase() === "skill.md") {
          const parent = vscode.Uri.file(nodePath.dirname(uri.fsPath));
          const target = vscode.Uri.file(nodePath.join(base, "skills", this.skillSlug(nodePath.basename(parent.fsPath))));
          await vscode.workspace.fs.createDirectory(target);
          await this.copyDirectory(parent, target);
        }
      } catch { /* ignore unreadable drops */ }
    }
    await this.refreshLibrary();
  }

  private async addSkillFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Add skill" });
    if (!picked?.length) return;
    const source = picked[0]!;
    const base = this.libraryRoot();
    if (!base) { void vscode.window.showWarningMessage("Bee Code: open a workspace first."); return; }
    const target = vscode.Uri.file(nodePath.join(base, "skills", this.skillSlug(nodePath.basename(source.fsPath))));
    await vscode.workspace.fs.createDirectory(target);
    await this.copyDirectory(source, target);
    if (!(await this.exists(vscode.Uri.joinPath(target, "SKILL.md")))) {
      void vscode.window.showWarningMessage("Bee Code: the selected folder has no SKILL.md.");
      return;
    }
    await this.refreshLibrary();
  }

  private async addSkillFiles(files: Array<{ path: string; data: string }>): Promise<void> {
    const base = this.libraryRoot();
    if (!base || !files.length) return;
    const normalized = files.map((f) => ({ path: f.path.replace(/\\/g, "/").replace(/^\/+/, ""), data: f.data }));
    const first = normalized[0]!.path.split("/")[0]!;
    const sameRoot = normalized.every((f) => f.path.split("/")[0] === first);
    const rootName = sameRoot && normalized.length > 1 ? first : this.skillSlug(first.replace(/\.md$/i, ""));
    const targetDir = vscode.Uri.file(nodePath.join(base, "skills", this.skillSlug(rootName)));
    await vscode.workspace.fs.createDirectory(targetDir);
    for (const file of normalized) {
      const rel = sameRoot && normalized.length > 1 ? file.path.slice(first.length + 1) : file.path;
      if (!rel || rel.includes("..")) continue;
      const target = vscode.Uri.joinPath(targetDir, ...rel.split("/"));
      await vscode.workspace.fs.writeFile(target, Buffer.from(file.data, "base64"));
    }
    if (!(await this.exists(vscode.Uri.joinPath(targetDir, "SKILL.md")))) {
      void vscode.window.showWarningMessage("Bee Code: dropped files must include SKILL.md.");
      return;
    }
    await this.refreshLibrary();
  }

  private async addMcpFile(files: Array<{ name: string; text: string }>): Promise<void> {
    const base = this.libraryRoot();
    if (!base) { void vscode.window.showWarningMessage("Bee Code: open a workspace first."); return; }
    let configs = files.filter((f) => f.name.toLowerCase().endsWith(".json"));
    if (!configs.length) {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { JSON: ["json"] }, openLabel: "Add MCP config" });
      if (!picked?.length) return;
      configs = [{ name: picked[0]!.fsPath, text: Buffer.from(await vscode.workspace.fs.readFile(picked[0]!)).toString("utf8") }];
    }
    const configPath = vscode.Uri.file(nodePath.join(base, "mcp.json"));
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(configPath)).toString("utf8")) as Record<string, unknown>; } catch { /* new file */ }
    const servers = { ...((existing.mcpServers as Record<string, unknown> | undefined) ?? {}), ...((existing.servers as Record<string, unknown> | undefined) ?? {}) };
    for (const file of configs) {
      try {
        const parsed = JSON.parse(file.text) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
        Object.assign(servers, parsed.mcpServers ?? parsed.servers ?? {});
      } catch {
        void vscode.window.showWarningMessage(`Bee Code: invalid MCP JSON: ${file.name}`);
      }
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(base));
    await vscode.workspace.fs.writeFile(configPath, Buffer.from(JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8"));
    await this.refreshLibrary();
  }

  private async removeSkill(name: string): Promise<void> {
    const base = this.libraryRoot();
    if (!base || !/^[A-Za-z0-9._-]+$/.test(name)) return;
    await vscode.workspace.fs.delete(vscode.Uri.file(nodePath.join(base, "skills", name)), { recursive: true, useTrash: true });
    await this.refreshLibrary();
  }

  private async removeMcp(name: string): Promise<void> {
    const base = this.libraryRoot();
    if (!base) return;
    const configPath = vscode.Uri.file(nodePath.join(base, "mcp.json"));
    try {
      const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(configPath)).toString("utf8")) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
      const servers = { ...(parsed.mcpServers ?? parsed.servers ?? {}) };
      delete servers[name];
      await vscode.workspace.fs.writeFile(configPath, Buffer.from(JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8"));
      await this.refreshLibrary();
    } catch { /* nothing to remove */ }
  }

  private skillSlug(name: string): string {
    return (name || "skill").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
  }

  private async copyDirectory(source: vscode.Uri, target: vscode.Uri): Promise<void> {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(source)) {
      const from = vscode.Uri.joinPath(source, name);
      const to = vscode.Uri.joinPath(target, name);
      if (type === vscode.FileType.Directory) {
        await vscode.workspace.fs.createDirectory(to);
        await this.copyDirectory(from, to);
      } else {
        await vscode.workspace.fs.writeFile(to, await vscode.workspace.fs.readFile(from));
      }
    }
  }

  // ── Python environment setup ─────────────────────────────────────────────

  /** Probe candidate interpreters, install missing dependencies, and save the selected path. */
  private async setupPython(): Promise<void> {
    const bundled = resolvePython("auto", this.context.extensionUri.fsPath);
    const candidates: Array<{ file: string; args: string[] }> = [
      { file: bundled.path, args: [] },
      { file: this.config.pythonPath, args: [] },
      { file: "python3", args: [] },
      { file: "python", args: [] },
      ...(process.platform === "win32" ? [{ file: "py", args: ["-3"] }] : []),
    ];
    const seen = new Set<string>();
    const probes: Array<{ file: string; args: string[]; version: string; httpx: boolean }> = [];
    for (const candidate of candidates) {
      const key = `${candidate.file} ${candidate.args.join(" ")}`;
      if (seen.has(key) || !candidate.file) continue;
      seen.add(key);
      const probe = await this.probePython(candidate.file, candidate.args);
      if (probe) probes.push({ ...candidate, ...probe });
    }

    const picked = await vscode.window.showQuickPick(
      [
        ...probes.map((probe) => ({
          label: `${probe.file}${probe.args.length ? ` ${probe.args.join(" ")}` : ""}`,
          description: `Python ${probe.version}${probe.httpx ? "" : " · missing httpx"}`,
          file: probe.file,
          args: probe.args,
          httpx: probe.httpx,
          version: probe.version,
        })),
        { label: "Enter a Python path manually…", description: "", file: "", args: [] as string[], httpx: false, version: "" },
      ],
      { title: "Bee Code: set up the Python core", placeHolder: "Choose the Python interpreter that should run beecode" },
    );
    if (!picked) return;

    let file = picked.file;
    let args = picked.args;
    if (!file) {
      const input = await vscode.window.showInputBox({
        title: "Bee Code: Python interpreter path",
        prompt: "Absolute path to python.exe / python3",
        value: this.config.pythonPath,
        ignoreFocusOut: true,
      });
      if (!input?.trim()) return;
      file = input.trim();
      args = [];
    }

    let probe = await this.probePython(file, args);
    if (!probe) {
      void vscode.window.showErrorMessage(`Bee Code: ${file} could not be started as Python.`);
      return;
    }
    if (!probe.httpx) {
      const install = await vscode.window.showWarningMessage(
        `Bee Code: ${file} (Python ${probe.version}) is missing httpx. Install the beecode dependencies now?`,
        { modal: true },
        "Install dependencies",
      );
      if (install !== "Install dependencies") return;
      await this.installPythonDeps(file, args);
      probe = await this.probePython(file, args);
      if (!probe?.httpx) {
        void vscode.window.showErrorMessage("Bee Code: dependencies are still missing. See the terminal output for details.");
        return;
      }
    }
    if (!this.versionAtLeast(probe.version, 3, 11)) {
      void vscode.window.showErrorMessage(`Bee Code: Python ${probe.version} is too old; 3.11 or newer is required.`);
      return;
    }

    await vscode.workspace.getConfiguration("beeCode").update("core.pythonPath", file, vscode.ConfigurationTarget.Global);
    this.config = readConfig().config;
    void vscode.window.showInformationMessage(`Bee Code: Python core set to ${file} (Python ${probe.version}).`);
    await this.restartCore();
  }

  private async probePython(file: string, args: string[]): Promise<{ version: string; httpx: boolean } | undefined> {
    const script =
      'import sys,json\n' +
      'try:\n import httpx; ok=True\nexcept Exception:\n ok=False\n' +
      'print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"httpx":ok}))';
    try {
      const { stdout } = await execFileAsync(file, [...args, "-c", script], { timeout: 8000, windowsHide: true });
      const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "{}") as { version?: string; httpx?: boolean };
      if (!parsed.version) return undefined;
      return { version: parsed.version, httpx: Boolean(parsed.httpx) };
    } catch {
      return undefined;
    }
  }

  private versionAtLeast(version: string, major: number, minor: number): boolean {
    const [a, b] = version.split(".").map((part) => Number.parseInt(part, 10));
    return (a ?? 0) > major || ((a ?? 0) === major && (b ?? 0) >= minor);
  }

  private async installPythonDeps(file: string, args: string[]): Promise<void> {
    const coreRoot = this.config.coreRoot || this.context.extensionUri.fsPath;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Bee Code: installing Python dependencies" },
      async () => {
        try {
          await execFileAsync(file, [...args, "-m", "pip", "install", "-e", coreRoot], { timeout: 300_000, windowsHide: true });
        } catch (err) {
          this.log.warn(`pip install failed: ${err instanceof Error ? err.message : String(err)}`);
          await execFileAsync(file, [...args, "-m", "pip", "install", "httpx>=0.27", "pydantic>=2.7"], { timeout: 300_000, windowsHide: true });
        }
      },
    );
  }

  /** Command palette: choose the user-visible UI language. */
  private async switchLanguage(): Promise<void> {
    const current = this.config.language;
    const picked = await vscode.window.showQuickPick(
      [
        { label: "English", description: current === "en" ? "Current" : "", value: "en" as const },
        { label: tr(this.config.language, "中文", "Chinese"), description: current === "zh" ? tr(this.config.language, "当前", "Current") : "", value: "zh" as const },
      ],
      { title: "Bee Code: switch UI language", placeHolder: "Panel, logs, hints and notifications" },
    );
    if (!picked) return;
    await vscode.workspace
      .getConfiguration("beeCode")
      .update("ui.language", picked.value, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Bee Code: UI language set to ${picked.label}.`);
  }

  private async exportDiagnostics(): Promise<void> {
    const uri = await writeDiagnostics({
      context: this.context,
      logger: this.log,
      config: this.config,
      coreKind: this.core?.kind ?? this.config.coreMode,
    });
    const name = nodePath.basename(uri.fsPath);

    const choice = await vscode.window.showInformationMessage(
      tr(this.config.language, `Bee Code: 诊断包已生成（已脱敏）— ${name}`, `Bee Code: Diagnostics bundle generated (redacted) — ${name}`),
      tr(this.config.language, "打开所在文件夹", "Open Containing Folder"),
      tr(this.config.language, "另存为…", "Save As…"),
    );
    if (choice === tr(this.config.language, "打开所在文件夹", "Open Containing Folder")) {
      await vscode.commands.executeCommand("revealFileInOS", uri);
      return;
    }
    if (choice === tr(this.config.language, "另存为…", "Save As…")) {
      const target = await vscode.window.showSaveDialog({
        title: tr(this.config.language, "另存诊断包", "Save Diagnostics Bundle"),
        defaultUri: vscode.Uri.file(nodePath.join(os.homedir(), name)),
        filters: { Markdown: ["md"] },
      });
      if (!target) return;
      await vscode.workspace.fs.copy(uri, target, { overwrite: true });
      void vscode.window.showInformationMessage(tr(this.config.language, `已保存到 ${target.fsPath}`, `Saved to ${target.fsPath}`));
    }
  }

  // ───────────────────────── Core notifications ─────────────────────────

  private onCoreNotification(method: string, params: unknown): void {
    switch (method) {
      case "ui.delta": {
        const p = params as UiDeltaParams;
        this.assistantBuffer += p.text;   // for persistence (the panel's streaming display is a separate path)
        this.panel.setActivity(tr(this.config.language, "生成回复…", "Generating reply…"));
        this.panel.appendDelta(p.text);
        return;
      }
      case "ui.tool": {
        const tool = params as UiToolParams;
        if (tool.status === "start" && tool.name !== "model" && tool.name !== "guard") {
          this.turnTools.add(tool.name);
          this.turnTrace.push({
            type: "tool",
            name: tool.name,
            args: typeof tool.args === "string" ? tool.args : tool.args ? JSON.stringify(tool.args) : undefined,
            status: "start",
          });
        }
        if (tool.status !== "start" && tool.name !== "model" && tool.name !== "guard") {
          const note = `${tool.name}${tool.summary ? `: ${tool.summary}` : ""}`;
          this.turnObservations.push(note);
          if (this.turnObservations.length > 12) this.turnObservations.shift();
          const step = [...this.turnTrace]
            .reverse()
            .find((item) => item.type === "tool" && item.name === tool.name && item.status === "start");
          if (step) {
            step.status = tool.status;
            step.summary = tool.summary;
            step.detail = tool.detail;
            step.durationMs = tool.durationMs;
          } else {
            this.turnTrace.push({
              type: "tool",
              name: tool.name,
              status: tool.status,
              summary: tool.summary,
              detail: tool.detail,
              durationMs: tool.durationMs,
            });
          }
        }
        if (tool.name === "guard" && tool.summary) {
          this.turnTrace.push({ type: "error", text: tool.summary });
        }
        if (tool.status === "start") {
          this.turn = "tool";
          this.turnDetail = tool.name;
          void this.sessions.updateStatus(this.sessionId, "thinking");
        }
        const p = params as UiToolParams;
        this.panel.setActivity(
          tr(
            this.config.language,
            `${p.status === "start" ? "运行工具" : p.status === "end" ? "完成" : "失败"}：${p.name}`,
            `${p.status === "start" ? "Running tool" : p.status === "end" ? "Done" : "Failed"}: ${p.name}`,
          ),
        );
        if (p.name !== "model" && p.name !== "guard") this.panel.toolEvent(p);
        this.panel.setHint(tr(this.config.language, `${p.status === "start" ? "运行" : p.status === "end" ? "完成" : "失败"}：${p.name}`, `${p.status === "start" ? "运行" : p.status === "end" ? "完成" : "失败"}: ${p.name}`));
        return;
      }
      case "ui.read": {
        const p = params as UiReadParams;
        this.panel.readEvent(p);
        const name = p.path.split("/").pop() || p.path;
        const drawn = this.config.focus.highlight ? this.focusHighlight.addRead(p) : false;
        this.panel.setHint(
          drawn && p.startLine && p.endLine
            ? tr(this.config.language, `读取 ${name}:${p.startLine}-${p.endLine}`, `Read ${name}:${p.startLine}-${p.endLine}`)
            : tr(this.config.language, `读取 ${name}`, `Read ${name}`),
        );
        return;
      }
      case "ui.reasoning": {
        const p = params as UiReasoningParams;
        const round = typeof p.round === "number" && p.round > 0 ? p.round : 1;
        this.panel.setActivity(tr(this.config.language, "思考中…", "Thinking…"));
        this.reasoningSegments.set(round, (this.reasoningSegments.get(round) ?? "") + p.text);
        const existing = this.turnTrace.find((step) => step.type === "reasoning" && step.round === round);
        if (existing) existing.text = (existing.text ?? "") + p.text;
        else this.turnTrace.push({ type: "reasoning", round, text: p.text });
        this.panel.reasoningDelta(p.text, round);
        return;
      }
      case "ui.intent": {
        const p = params as UiIntentParams;
        this.panel.setActivity(tr(this.config.language, "分析请求…", "Analyzing request…"));
        // Intent analysis itself isn't displayed (it produces no message); the panel only updates the mode badge and hint
        this.turnScale = p.scale === "large" ? "large" : "small";
        this.turnIntent = {
          intent: p.intent,
          mode: p.mode,
          scale: p.scale,
          needsProposal: p.needsProposal,
          reason: p.reason,
        };
        this.panel.setMode(p.mode);
        const label = p.mode === "builder" ? "Builder" : p.mode === "debugger" ? "Debugger" : "Chat";
        const flags = [
          p.scale === "large" ? tr(this.config.language, "大任务", "Large task") : "",
          p.needsProposal ? tr(this.config.language, "需产出提案", "Proposal needed") : "",
          p.degraded ? tr(this.config.language, "降级判定", "Downgraded") : "",
          p.reused ? tr(this.config.language, "沿用上轮意图", "Reused previous intent") : "",
        ].filter(Boolean);
        this.panel.setHint(`${label}${flags.length ? `（${flags.join("，")}）` : ""} · ${p.reason ?? ""}`);
        this.sessions.updateLastIntent(this.sessionId, {
          mode: p.mode,
          scale: p.scale,
          needsProposal: p.needsProposal,
          intent: p.intent,
          reason: p.reason,
        });
        if (this.turnUserMessageId) {
          this.panel.addTrajectoryItem({
            id: this.turnUserMessageId,
            mode: p.mode,
            intent: p.intent || p.reason || tr(this.config.language, "（未记录意图）", "(no intent recorded)"),
          });
        }
        return;
      }
      case "ui.diagram": {
        const p = params as UiDiagramParams;
        this.turnDiagrams.push(p.diagram);
        this.turnTrace.push({
          type: "diagram",
          name: p.diagram.kind,
          title: p.diagram.title,
          text: p.diagram.source,
        });
        this.panel.diagramEvent(p);
        return;
      }
      case "ui.plan": {
        const p = params as UiPlanParams;
        this.turnPlan = p.steps;
        this.panel.planEvent(p);
        this.sessions.updatePlan(this.sessionId, p.steps);
        return;
      }
      case "ui.subagent": {
        const p = params as UiSubagentParams;
        this.panel.subagentEvent(p);
        if (p.status === "start") {
          this.turn = "tool";
          this.panel.setHint(tr(this.config.language, `子代理：${p.task ?? ""}`, `Sub-agent: ${p.task ?? ""}`));
        } else if (p.status === "tool" && p.tool) {
          this.panel.setHint(tr(this.config.language, `子代理 · ${p.tool.name}${p.tool.summary ? ` ${p.tool.summary}` : ""}`, `Sub-agent · ${p.tool.name}${p.tool.summary ? ` ${p.tool.summary}` : ""}`));
        } else if (p.status === "end") {
          this.panel.setHint(
            p.error ? tr(this.config.language, `子代理失败：${p.error}`, `Sub-agent failed: ${p.error}`) : tr(this.config.language, `子代理完成（${p.steps ?? 0} 步 / ${p.toolCalls ?? 0} 次工具）`, `Sub-agent finished (${p.steps ?? 0} steps / ${p.toolCalls ?? 0} tool calls)`),
          );
        }
        return;
      }
      case "ui.usage": {
        const p = params as UiUsageParams;
        const cost = typeof p.costUsd === "number" ? ` · $${p.costUsd.toFixed(4)}` : "";
        this.usage = `${p.inputTokens ?? 0}→${p.outputTokens ?? 0} tok${cost}`;
        this.turnUsage = {
          inputTokens: p.inputTokens ?? 0,
          outputTokens: p.outputTokens ?? 0,
          elapsedMs: p.elapsedMs ?? 0,
          modelWaitMs: p.modelWaitMs ?? 0,
          toolMs: p.toolMs ?? 0,
        };
        const tokens = (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
        const seconds = (p.elapsedMs ?? 0) / 1000;
        const nearTokens = tokens > this.config.maxTurnTokens * 0.8;
        const fmtTokens = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
        this.panel.setCost(
          `${fmtTokens} tok · ${seconds.toFixed(1)}s${nearTokens ? " · ⚠ near token budget" : ""}`,
        );
        this.updateStatus();
        return;
      }
      case "ui.retry": {
        const retry = params as UiRetryParams;
        const retrySessionId = retry.sessionId || this.sessionId;
        this.retries.appendSync({
          ts: Date.now(),
          sessionId: retrySessionId,
          status: (retry.status ?? "waiting") as RetryEvent["status"],
          ...(retry.attempt !== undefined ? { attempt: retry.attempt } : {}),
          ...(retry.max !== undefined ? { max: retry.max } : {}),
          ...(retry.delayMs !== undefined ? { delayMs: retry.delayMs } : {}),
          ...(retry.reason ? { reason: retry.reason.slice(0, 500) } : {}),
        });
        this.panel.retryEvent(retry);
        return;
      }
      case "proposal.changed": {
        const changed = params as ProposalChangedParams;
        for (const dto of changed.added ?? []) this.turnFiles.add(dto.path);
        this.applyProposalChange(changed);
        this.turn = this.proposals.count() > 0 ? "awaiting-decision" : "idle";
        void this.sessions.updateStatus(this.sessionId, "thinking");
        return;
      }
      case "log": {
        const p = params as LogParams;
        const level = p.level === "error" ? "error" : p.level === "warn" ? "warn" : "info";
        this.log[level](tr(this.config.language, `[内核] ${p.msg ?? ""}`, `[core] ${p.msg ?? ""}`));
        return;
      }
      default:
        this.log.debug(`Unhandled core notification: ${method}`);
    }
  }

  private applyProposalChange(change: ProposalChangedParams): void {
    if (change.removed?.includes("*")) {
      this.proposals.clear();
    } else {
      for (const id of change.removed ?? []) this.proposals.remove(id);
    }
    for (const dto of change.added ?? []) this.proposals.upsert(dto);
    for (const dto of change.updated ?? []) this.proposals.upsert(dto);
    this.refreshProposals();
  }

  private refreshProposals(): void {
    const visible = this.proposals.visible();
    this.panel.setProposals(visible);
    this.updateStatus();
    for (const proposal of visible) {
      if (proposal.status !== "pending" || this.autoOpenedProposals.has(proposal.id)) continue;
      this.autoOpenedProposals.add(proposal.id);
      void this.showProposal(proposal.id);
    }
  }

  // ───────────────────────── Adapter registration ─────────────────────────

  private registerAdapters(): void {
    const fs = createFsAdapter(this.log);
    const search = createSearchAdapter(this.log);
    const symbols = createSymbolsAdapter(this.log);
    const diagnostics = createDiagnosticsAdapter(this.log);
    const secrets = createSecretAdapter(this.context, this.log);

    // Generic register: method names are tightly bound to parameter/return types, so mistakes fail at compile time
    this.server.register("fs.read", async (params, ctx) => {
      await this.ensurePathAccess(params.path, ctx, params.role === "subagent" ? "subagent" : "main");
      return fs.read(params, ctx);
    });
    this.server.register("fs.list", (params, ctx) => fs.list(params, ctx));
    this.server.register("search.grep", (params, ctx) => search.grep(params, ctx));
    this.server.register("symbols.outline", (params, ctx) => symbols.outline(params, ctx));
    this.server.register("symbols.search", (params, ctx) => symbols.search(params, ctx));
    this.server.register("symbols.references", (params, ctx) => symbols.references(params, ctx));
    this.server.register("diagnostics.get", (params, ctx) => diagnostics.get(params, ctx));
    this.server.register("edit.apply", async (params, ctx) => {
      await this.assertWriteAllowed(params.path, ctx, { userApproved: false, role: params.role === "subagent" ? "subagent" : "main" });
      return this.edit.apply(params, ctx);
    });
    this.server.register("run", (params, ctx) => this.runCommand(params, ctx));
    this.server.register("command.wait", (params, ctx) => this.commandWait(params, ctx));
    this.server.register("command.terminate", (params) => this.commandTerminate(params));
    this.server.register("command.list", () => this.commandList());
    this.server.register("checkpoint.create", (params) => this.checkpoint.create(params));
    this.server.register("checkpoint.restore", (params) => this.checkpoint.restore(params));
    this.server.register("diff.open", (params) => this.diff.open(params));
    this.server.register("secrets.get", (params) => secrets.get(params));
    this.server.register("confirm.ask", (params, ctx) => this.approvals.run(() => this.confirm.ask(params, ctx)));

    // Use info rather than debug: the log channel's default level is info, so debug output gets filtered out
    this.log.info(`Registered RPC methods: ${this.server.listed().join(", ")}`);

    this.verifyProtocolContract();
  }

  /**
   * Command reconciliation: registered ↔ declared in package.json. When the two disagree, the command palette silently misses entries / clicking errors out.
   */
  private verifyCommands(registered: string[]): void {
    const problems = undeclaredCommands(this.context, registered);
    if (problems.length === 0) {
      this.log.info(`Command reconciliation passed (${registered.length})`);
      return;
    }
    for (const problem of problems) this.log.error(`Command reconciliation: ${problem}`);
    void vscode.window.showWarningMessage(tr(this.config.language, `Bee Code: 命令声明与注册不一致（${problems.length} 处），详见输出面板。`, `Bee Code: Command declarations do not match their registration (${problems.length} issues); see the output panel.`));
  }

  /**
   * Protocol self-check: reconcile "methods registered at runtime" against `protocol/contract.json`.
   *
   * This is the only mechanism that can catch "TS added a method but the Python contract didn't follow" (or vice versa) —
   * types disappear after compilation, and Python can't see TypeScript either; this JSON is the shared source of truth.
   * Failure doesn't block startup (the workspace may not contain a contract file), but it is reported prominently.
   */
  private verifyProtocolContract(): void {
    const check = loadContract([
      this.context.extensionUri.fsPath,
      workspaceRoots()[0],
      process.cwd(),
    ]);
    if (!check.contract) {
      for (const problem of check.problems) this.log.warn(`Protocol contract: ${problem}`);
      return;
    }
    const problems = verifyRegistration(check.contract, this.server.listed());
    if (problems.length === 0) {
      this.log.info(`Protocol contract verified (version=${check.contract.version}, ${this.server.listed().length} methods)`);
      return;
    }
    for (const problem of problems) this.log.error(`Protocol contract mismatch: ${problem}`);
    void vscode.window.showWarningMessage(
      tr(this.config.language, `Bee Code: 协议契约与实际注册不一致（${problems.length} 处），详见输出面板。`, `Bee Code: Protocol contracts do not match the actual registrations (${problems.length} issues); see the output panel.`),
    );
  }

  // ───────────────────────── Miscellaneous ─────────────────────────

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.panel.setBusy(busy);
    this.panel.setActivity(busy ? tr(this.config.language, "思考中…", "Thinking…") : "");
    this.updateStatus();
  }

  private updateStatus(): void {
    const pendingCount = this.proposals.count();
    const parts = [`$(bee) Bee Code`];
    if (this.busy) parts.push("$(sync~spin)");
    if (pendingCount > 0) parts.push(tr(this.config.language, `待审 ${pendingCount}`, `${pendingCount} pending`));
    if (this.usage) parts.push(this.usage);
    this.status.text = parts.join(" · ");
    this.status.tooltip = tr(this.config.language, `${describeConfig(this.config)}\n点击打开面板`, `${describeConfig(this.config)}\nClick to open the panel`);
  }

  private hintForState(): string {
    if (isWorkspaceEmpty()) return tr(this.config.language, "请先打开一个工作区（文件夹），否则无法读取代码。", "Open a workspace folder first; otherwise the code cannot be read.");
    const missing: string[] = [];
    if (!this.config.model.baseUrl) missing.push("base_url");
    if (!this.config.model.model) missing.push("model");
    if (missing.length > 0) return tr(this.config.language, `未配置 ${missing.join(" / ")}：运行「Bee Code: 配置模型」`, `Not configured: ${missing.join(" / ")}. Run "Bee Code: Configure model".`);
    const keySource = process.env[API_KEY_ENV] ? tr(this.config.language, " · 密钥来自环境变量", " · key from environment variable") : "";
    return tr(this.config.language, `内核模式：${this.config.coreMode}${keySource}`, `Core mode: ${this.config.coreMode}${keySource}`);
  }

  /**
   * Unified guidance when there's no workspace: leave a record in the panel + show one prompt with action buttons.
   *
   * Why not just fail: when the core can't get workspaceRoots, reading files/writing checkpoints/diffs
   * all surface as indirect errors like "path out of bounds" or "workspace not found", and the user can't guess the cause.
   */
  private async promptOpenWorkspace(): Promise<void> {
    const message = tr(this.config.language, "Bee Code: 请先打开一个工作区（文件夹），扩展需要它来读取代码与保存检查点。", "Bee Code: Open a workspace folder first; the extension needs one to read code and save checkpoints.");
    this.panel.addMessage({ id: `sys_${Date.now()}`, role: "system", text: message });
    this.panel.setHint(tr(this.config.language, "未打开工作区", "No workspace open"));

    const choice = await vscode.window.showWarningMessage(message, tr(this.config.language, "打开文件夹", "Open Folder"), tr(this.config.language, "稍后", "Later"));
    if (choice === tr(this.config.language, "打开文件夹", "Open Folder")) {
      await vscode.commands.executeCommand("vscode.openFolder");
    }
  }
}

function toAttachment(context: AttachedContext): Attachment {
  return {
    path: toWorkspaceRelative(context.path),
    ...(context.startLine ? { startLine: context.startLine } : {}),
    ...(context.endLine ? { endLine: context.endLine } : {}),
    ...(context.text ? { text: context.text } : {}),
    kind: context.kind,
    ...(context.symbol ? { symbol: context.symbol } : {}),
  };
}

/**
 * If the end of the history is exactly this turn's user input, drop it.
 *
 * The shell writes the user message to the session store before building the context, so the last entry in `history` is this turn's input;
 * and `text` is passed separately as well. Without deduplication the core would receive two copies of the same user message.
 */
function stripTrailingUser(history: ChatMessage[], text: string): ChatMessage[] {
  // A background-task system notice may have been appended afterwards; skip trailing system messages before looking for the current user message
  let index = history.length - 1;
  while (index >= 0 && history[index]?.role === "system") index -= 1;
  const candidate = history[index];
  if (candidate && candidate.role === "user" && candidate.text.trim() === text.trim()) {
    return history.filter((_, i) => i !== index);
  }
  return history;
}

/** Defensive clamping: the panel state may come from an older version or have been tampered with */
function clampAttachments(
  items: AttachedContext[],
  limits: { maxCount: number; maxTotalChars: number; maxCharsPerItem: number },
  locale: Locale,
): { items: AttachedContext[]; notices: string[] } {
  const notices: string[] = [];
  if (items.length > limits.maxCount) {
    notices.push(tr(locale, `最多附加 ${limits.maxCount} 段：本次只保留了前 ${limits.maxCount} 段，其余已忽略。`, `At most ${limits.maxCount} attachments: only the first ${limits.maxCount} were kept this time; the rest were ignored.`));
  }
  const out: AttachedContext[] = [];
  let total = 0;
  let truncatedItem = false;
  let truncatedTotal = false;
  for (const item of items.slice(0, limits.maxCount)) {
    let text = item.text ?? "";
    if (text.length > limits.maxCharsPerItem) {
      text = tr(locale, `${text.slice(0, limits.maxCharsPerItem)}\n…（附件已截断）`, `${text.slice(0, limits.maxCharsPerItem)}\n…(attachment truncated)`);
      truncatedItem = true;
    }
    const remaining = limits.maxTotalChars - total;
    if (remaining <= 0) {
      truncatedTotal = true;
      break;
    }
    if (text.length > remaining) {
      text = tr(locale, `${text.slice(0, remaining)}\n…（附件已截断）`, `${text.slice(0, remaining)}\n…(attachment truncated)`);
      truncatedTotal = true;
    }
    total += text.length;
    out.push({ ...item, ...(text.length > 0 ? { text } : {}) });
  }
  if (truncatedItem) notices.push(tr(locale, `单个附件超过 ${limits.maxCharsPerItem} 字符，已截断。`, `A single attachment exceeds ${limits.maxCharsPerItem} characters and was truncated.`));
  if (truncatedTotal) notices.push(tr(locale, `附件合计超过 ${limits.maxTotalChars} 字符，已截断到上限。`, `Attachments exceed ${limits.maxTotalChars} characters in total and were truncated to the limit.`));
  return { items: out, notices };
}

/** Cost display: 12.3k tok · 8.4s; returns an empty string when there's no data */
function formatTurnCost(inputTokens?: number, outputTokens?: number, elapsedMs?: number): string {
  const tokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  const seconds = (elapsedMs ?? 0) / 1000;
  if (tokens === 0 && seconds === 0) return "";
  const parts: string[] = [];
  if (tokens > 0) parts.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`);
  if (seconds > 0) parts.push(`${seconds.toFixed(1)}s`);
  return parts.join(" · ");
}

/** Unfinished plan (no need to pass it to the model when everything is done) */
function pendingPlan(plan: PlanStep[] | undefined): PlanStep[] | undefined {
  if (!plan || plan.length === 0) return undefined;
  return plan.some((step) => step.status !== "done") ? plan : undefined;
}

/** Permission denial: use the name PathPolicyError so the shell's rpcCodeFor maps it to DENIED(-32013) */
function deniedError(reason: string): Error {
  const err = new Error(reason);
  err.name = "PathPolicyError";
  return err;
}

/** Context for local actions (not triggered by RPC): not cancellable */
function localContext(): InboundRequestContext {
  return {
    id: "local",
    signal: new AbortController().signal,
    throwIfCancelled() {
      /* Local actions are not cancellable */
    },
  };
}

/** FocusInfo → panel attachment (kind=focus, the core uses it to generate the "near the cursor" heading) */
function toFocusContext(info: FocusInfo): AttachedContext {
  return {
    path: info.path,
    startLine: info.startLine,
    endLine: info.endLine,
    text: info.text,
    kind: "focus",
    ...(info.symbol ? { symbol: info.symbol } : {}),
    ...(info.untitled ? { untitled: true } : {}),
  };
}

/** FocusInfo → the protocol's FocusDto (no body; the body goes through the attachment) */
function focusDto(info: FocusInfo): FocusDto {
  return {
    path: info.path,
    line: info.line,
    startLine: info.startLine,
    endLine: info.endLine,
    kind: info.kind,
    ...(info.symbol ? { symbol: info.symbol } : {}),
  };
}