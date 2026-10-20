import * as os from "node:os";
import * as nodePath from "node:path";
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
import { API_KEY_ENV, SUBAGENT_API_KEY_ENV, defaultInstruction, describeConfig, isWorkspaceEmpty, newSessionId, readConfig, workspaceRoots, type ShellConfig } from "./config";
import { loadContract, verifyRegistration } from "./contract";
import type { CoreApi, InboundRequestContext } from "./coreApi";
import { CoreNotFoundError, describeLaunch, locateCore } from "./coreLocator";
import { exportDiagnostics as writeDiagnostics } from "./diagnostics";
import { MockCore } from "./dev/mockCore";
import { Logger } from "./log";
import { ChatViewProvider, type AttachedContext } from "./panel/chatViewProvider";
import { toWorkspaceRelative } from "./paths";
import { readFocusAtCursor, type FocusInfo } from "./focus";
import { FocusHighlighter } from "./focusDecoration";
import { CheckpointChatIndex } from "./checkpointChatIndex";
import { TurnStore } from "./turnStore";
import { SummaryStore } from "./summaryStore";
import { buildRuleSet, evaluate, isSensitiveWrite, type Evaluation, type RuleSet } from "./permissions";
import { createRunAdapter, detectDocker } from "./adapters/runAdapter";
import { ensureWorkspaceTrust, isTrusted, toggleWorkspaceTrust } from "./trust";
import { decide as decidePolicy, isReadOnlyCommand, type AgentRole, type PolicyDecision } from "./policy";
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
  RunParams,
  RunResult,
  UiDeltaParams,
  PlanStep,
  UiIntentParams,
  UiPlanParams,
  UiReadParams,
  UiSubagentParams,
  UiToolParams,
  UiUsageParams,
} from "./protocol";
const SESSION_KEY = "beeCode.sessionId";

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
 * 壳的装配根：所有依赖在这里一次性接好，其他地方只依赖接口。
 *
 * 这个类**不含业务逻辑**：提示词、工具循环、检索、补丁全在 Python 内核里。
 * 它只负责把内核的意图翻译成 VS Code 动作，以及把用户动作翻译成 RPC。
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
  /** 已落盘的消息条数（面板里的 vs 磁盘上的对齐用） */
  private persisted = 0;
  /** 早前轮次的机械摘要（喂给模型的 L1） */
  /** 本轮助手输出（ui.delta 累积；chatSend 结束后整段落盘） */
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
  private turnIntent?: { intent: string; mode: Mode };
  private readonly turnTools = new Set<string>();
  private readonly turnObservations: string[] = [];
  /** 本轮的计划（ui.plan 更新；落进 turn record 与 session meta） */
  private turnPlan: PlanStep[] = [];
  /** 本轮用户消息 id（右侧轨迹跳转用） */
  private turnUserMessageId: string | undefined;
  private readonly turnFiles = new Set<string>();
  /** 模型摘要缓存：covered = 已覆盖轮次数；lines 用于增量追加；持久化在 SummaryStore */
  private summaryCache?: { covered: number; coveredMessageIndex: number; text: string; lines: string[] };
  private rules: RuleSet = buildRuleSet({});
  private trusted = false;
  private dockerAvailable = false;
  private readonly sessions: SessionStore;
  /** 上一轮停在哪个阶段（持久化到磁盘，重载后可判断能否继续） */
  private turn: TurnStatus = "idle";
  private turnDetail: string | undefined;
  private readonly edit: ReturnType<typeof createEditAdapter>;
  private busy = false;
  private usage = "";
  /** 停用标志：保证 dispose 幂等，且停用后不再拉起内核/发请求 */
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.log = new Logger();
    const read = readConfig();
    this.config = read.config;
    for (const problem of read.problems) this.log.warn(`配置有问题：${problem}`);
    this.server = new ShellServer(this.log);
    this.diff = new DiffAdapter(this.log);
    this.checkpoint = new CheckpointAdapter(
      context,
      this.log,
      this.config.checkpointEnabled,
      this.config.checkpointRetention,
    );

    // 写入通道与提案暂存：提案被「接受」时才真正调用 this.edit 落盘
    this.edit = createEditAdapter(this.log);
    this.confirm = createConfirmAdapter(context, this.log);
    this.proposals = new ProposalAdapter(this.diff, this.edit, this.log);
    this.focusHighlight = new FocusHighlighter(this.log);
    this.chatIndex = new CheckpointChatIndex(nodePath.join(context.globalStorageUri.fsPath, "checkpoints"), this.log);
    this.turns = new TurnStore(nodePath.join(context.globalStorageUri.fsPath, "sessions"), this.log);
    this.summaries = new SummaryStore(nodePath.join(context.globalStorageUri.fsPath, "sessions"), this.log);
    this.runner = createRunAdapter({
      logger: this.log,
      policy: () => ({
        // 有 docker 就强制沙箱执行：这是策略，不是偏好（用户设 off 也不降级）
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
    });

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = "beeCode.chat.ask";
    this.status.show();

    this.registerAdapters();
  }

  async start(): Promise<void> {
    this.log.info(`激活：${describeConfig(this.config)}`);

    await this.ensureSession();
    await this.refreshPermissions();
    await this.initSandbox();

    // 所有"可释放资源"只有一个所有者：context.subscriptions。
    // VS Code 会在 deactivate() 后统一 dispose，避免我们与它双重释放。
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, this.panel, {
        webviewOptions: { retainContextWhenHidden: false },
      }),
    );

    const registeredCommands = registerCommands(this.context, {
      panel: this.panel,
      log: this.log,
      configureModel: () => this.configureModel(),
      restartCore: () => this.restartCore(),
      restoreCheckpoint: () => this.restoreCheckpoint(),
      acceptAll: () => this.acceptAllProposals(),
      rejectAll: () => this.rejectAllProposals(),
      continueTurn: () => this.continueTurn(),
      regenerateProposal: () => this.regenerateProposal(),
      cancelAcceptAll: () => this.cancelAcceptAll(),
      newSession: () => this.newSession(),
      testModel: () => this.testModel("main"),
      configureSubagent: () => this.configureSubagent(),
      testSubagent: () => this.testModel("subagent"),
      clearSubagentKey: () => this.clearSubagentKey(),
      redetectSandbox: () => this.redetectSandbox(),
      toggleTrust: async () => {
        await toggleWorkspaceTrust(this.context, this.log);
        await this.refreshPermissions();
      },
      clearModelKey: () => this.clearModelKey(),
      crashMock: () => {
        if (this.core instanceof MockCore) this.core.simulateCrash("用户通过命令触发");
        else void vscode.window.showInformationMessage("Bee Code: 当前内核不是 mock 模式，无法模拟崩溃。");
      },
      pickSession: () => this.pickSession(),
      clearRemembered: () => {
        clearRememberedChoices(this.context);
        void vscode.window.showInformationMessage("Bee Code: 已清除记住的确认选择。");
      },
      pickFiles: () => this.pickFiles(),
      focus: { fallbackLines: this.config.focus.fallbackLines, maxLines: this.config.focus.maxLines },
      highlightFocus: (focus: FocusInfo | undefined) => {
        if (this.config.focus.highlight) this.focusHighlight.show(focus);
      },
      exportDiagnostics: () => this.exportDiagnostics(),
    });
    this.verifyCommands(registeredCommands);

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("beeCode")) return;
        const read = readConfig();
        this.config = read.config;
        for (const problem of read.problems) this.log.warn(`配置有问题：${problem}`);
        this.log.info(`配置已更新：${describeConfig(this.config)}`);

        // 分流：只改模型相关 → 热更新（不重启进程）；其余（core/pythonPath/checkpoint…）→ 重启
        if ((event.affectsConfiguration("beeCode.model") || event.affectsConfiguration("beeCode.subagent")) && this.core) {
          void this.resolveApiKey().then((resolved) => {
            if (!this.core) return undefined;
            const subagent = this.effectiveSubagent();
            return this.resolveSubagentKey().then((subagentKey) =>
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
                    })
                    .catch((err: unknown) =>
                      this.log.warn(`model.reload 失败: ${err instanceof Error ? err.message : String(err)}`),
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

    this.context.subscriptions.push(this.status, this.log, this.diff, this.checkpoint, this.proposals, this.sessions, this.focusHighlight);
    this.updateStatus();
    this.panel.setHint(this.hintForState());
  }

  /**
   * 停用时的**有序**清理。
   *
   * 只做 subscriptions 覆盖不到的那件事：**按顺序停内核**（它是子进程 + 可能正在跑工具），
   * 其余资源（面板、命令、监听、状态栏、日志、适配器）都登记在 `context.subscriptions`，
   * 由 VS Code 在 `deactivate()` 返回后统一释放 —— 单一所有者，不会双重 dispose。
   *
   * 幂等：`disposed` 标志保证重复调用只生效一次。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // 先把最后几条消息落盘，再停内核
    await this.sessions.updateStatus(this.sessionId, "idle").catch(() => undefined);
    await this.sessions.flush().catch(() => undefined);

    const core = this.core;
    this.core = undefined;
    if (core) {
      await core.shutdown().catch(() => undefined);
      core.dispose();
    }
    this.log.info("已停用");
  }

  // ───────────────────────── 会话与上下文 ─────────────────────────

  /** 首次激活：读到上次的 sessionId 就续上，读不到就新建一个 */
  private async ensureSession(): Promise<void> {
    const existing = await this.sessions.open(this.sessionId);
    if (existing.length === 0 && !this.sessions.meta(this.sessionId)) {
      this.sessions.create({
        id: this.sessionId,
        title: "新会话",
        mode: this.panel.getMode(),
        workspace: workspaceRoots()[0] ?? "",
        createdAt: Date.now(),
      });
    }
    if (existing.length === 0) return;

    this.panel.restore(
      existing.map((m) => ({ id: m.id, role: m.role, text: m.text })),
      this.sessions.meta(this.sessionId)?.mode ?? this.panel.getMode(),
    );
    this.persisted = existing.length;
    this.log.info(`会话已恢复：${existing.length} 条消息（${this.sessionId}）`);
    this.panel.setPlan(this.sessions.meta(this.sessionId)?.plan);
    await this.loadSummary(existing.length);
    await this.refreshTrajectory();

    const meta = this.sessions.meta(this.sessionId);
    const status = meta?.status ?? "idle";   // 未写过的状态一律当 idle，别误报"被中断"
    const note = this.interruptionNote(status, meta?.statusDetail);
    if (note) {
      this.panel.addMessage({ id: `sys_${Date.now()}`, role: "system", text: note });
      this.panel.setHint(
        status === "tool"
          ? "上一轮停在工具调用：发「继续上次的操作」即可接着做。"
          : status === "awaiting-decision"
            ? "上次的提案已失效：发「重新生成提案」可以让 agent 再给一次。"
            : "上一轮生成被中断，已作废。",
      );
      this.turn = "idle";
      this.turnDetail = undefined;
      await this.sessions.updateStatus(this.sessionId, "idle");
    }
    this.panel.pushState();
  }

  private interruptionNote(status: TurnStatus, detail?: string): string {
    switch (status) {
      case "thinking":
        return "上一轮在模型生成过程中被重载中断，已作废（不会自动续写）。";
      case "tool":
        return `上一轮停在工具调用${detail ? `（${detail}）` : ""}后中断。想接着做，请发送「继续上次的操作」。`;
      case "awaiting-decision":
        return "上次的待审提案没有保留（重载会清空未决提案）。需要的话发送「重新生成提案」。";
      default:
        return "";
    }
  }

  /** 追加一条消息到磁盘（用户/助手/系统都走这里） */
  private remember(role: "user" | "assistant" | "system", text: string): void {
    if (!text.trim()) return;
    this.sessions.append(this.sessionId, { id: `${role[0]}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, role, text, ts: Date.now() });
  }

  /**
   * 构建发给模型的历史：**不是整份 transcript**，而是 `contextBuilder` 裁剪后的结果。
   *
   * 摘要 + 最近 N 条逐字；超预算先缩摘要，再从最旧的消息丢。
   */
  private async modelContext(): Promise<{ summary?: string; history: ChatMessage[] }> {
    const all = await this.sessions.open(this.sessionId);
    // 机械裁剪负责"取最近 8 条 + 兜底摘要"；模型摘要负责"更早轮次的可读总结"
    const built = buildContext(all, undefined);
    if (built.folded === 0) return { summary: built.summary, history: built.messages };

    const summary = await this.modelSummary(all.length);
    return { summary: summary ?? built.summary, history: built.messages };
  }

  /** 聊天回滚：摘要按"仍保留的轮次"截断，并同步落盘 */
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
      text: `[早前对话摘要 · 模型生成]\n${lines.join("\n")}`,
    };
    await this.summaries.save(this.sessionId, { covered: lines.length, coveredMessageIndex, lines });
    this.log.info(`摘要随聊天回滚截断到 ${lines.length} 轮`);
  }

  /** 从轮次记录重建右侧轨迹（重载/切换会话/回滚后用） */
  private async refreshTrajectory(): Promise<void> {
    const turns = await this.turns.list(this.sessionId);
    const items = turns
      .filter((turn) => typeof turn.userMessageId === "string" && turn.userMessageId.length > 0)
      .map((turn) => ({ id: turn.userMessageId as string, mode: turn.mode, intent: turn.intent }));
    this.panel.setTrajectory(items);
  }

  /** 从磁盘恢复摘要；会话被外部截断时丢弃（避免摘要覆盖不存在的轮次） */
  private async loadSummary(totalMessages: number): Promise<void> {
    const stored = await this.summaries.load(this.sessionId);
    if (!stored || stored.lines.length === 0) {
      this.summaryCache = undefined;
      return;
    }
    if (stored.coveredMessageIndex > totalMessages) {
      this.log.warn(`摘要记录覆盖 ${stored.coveredMessageIndex} 条，但会话只有 ${totalMessages} 条，丢弃旧摘要`);
      this.summaryCache = undefined;
      await this.summaries.remove(this.sessionId);
      return;
    }
    const lines = stored.lines.slice(0, stored.covered);
    this.summaryCache = {
      covered: lines.length,
      coveredMessageIndex: stored.coveredMessageIndex,
      lines,
      text: `[早前对话摘要 · 模型生成]\n${lines.join("\n")}`,
    };
    this.log.info(`摘要已恢复：覆盖 ${lines.length} 轮（${this.sessionId}）`);
  }

  /**
   * 用模型给"被折叠的轮次"生成摘要（增量）。
   *
   * 只把**新折叠进来**的轮次发给模型，结果追加到已有摘要行后面，
   * 避免历史越长、每次摘要越贵（O(n²)）。
   * 失败或 mock 内核返回空 → 退回机械摘要。
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
        })),
      });
      const newLines = (result.pairs ?? []).map((pair) => `- ${pair.intent}：${pair.summary}`);
      let text: string | undefined;
      let lines: string[] = [];
      if (newLines.length === fresh.length) {
        lines = [...(cached?.lines ?? []), ...newLines];
        text = `[早前对话摘要 · 模型生成]\n${lines.join("\n")}`;
      } else if (result.summary.trim()) {
        // 内核没给逐条结果（数量不齐）：整段替换，缓存重置为当前覆盖范围
        lines = result.summary.split("\n").filter((line) => line.trim().length > 0);
        text = result.summary;
      }
      if (!text) {
        this.log.debug("模型摘要为空，退回机械摘要");
        return cached?.text;
      }
      const coveredMessageIndex = covered[covered.length - 1]?.messageIndex ?? totalMessages;
      this.summaryCache = { covered: covered.length, coveredMessageIndex, text, lines };
      await this.summaries.save(this.sessionId, {
        covered: covered.length,
        coveredMessageIndex,
        lines,
      });
      this.log.info(`模型摘要：累计 ${covered.length} 轮（本次新增 ${fresh.length} 轮），已持久化`);
      return text;
    } catch (err) {
      this.log.warn(`模型摘要失败（退回机械摘要）：${err instanceof Error ? err.message : String(err)}`);
    }
    return cached?.text;
  }

  /** 一轮结束时落盘"意图 + 回答 + 工具 + 文件"，供后续按意图总结 */
  private async appendTurn(userText: string, assistant: string, fallbackMode: Mode): Promise<void> {
    const all = await this.sessions.open(this.sessionId);
    const intent = this.turnIntent?.intent || userText.replace(/\s+/g, " ").trim().slice(0, 120);
    await this.turns.append(this.sessionId, {
      intent,
      mode: this.turnIntent?.mode ?? fallbackMode,
      userText: userText.slice(0, 400),
      assistant: assistant.slice(0, 1200),
      tools: [...this.turnTools],
      files: [...this.turnFiles],
      observations: [...this.turnObservations],
      ...(this.turnPlan.length > 0 ? { plan: this.turnPlan } : {}),
      ...(this.turnUserMessageId ? { userMessageId: this.turnUserMessageId } : {}),
      ts: Date.now(),
      messageIndex: all.length,
    });
    // 会话标题跟随"最近一次用户意图"，比第一条消息更能概括这个会话
    if (intent.trim().length > 0) this.sessions.rename(this.sessionId, intent.trim().slice(0, 40));
    this.turnIntent = undefined;
    this.turnTools.clear();
    this.turnObservations.length = 0;
    this.turnFiles.clear();
  }

  /** 「继续上次的操作」：把历史带上，让内核接着上下文做 */
  private async continueTurn(): Promise<void> {
    await this.send("继续上次未完成的操作（上一次停在工具调用阶段）。", this.panel.getMode(), []);
  }

  /** 「重新生成提案」：上一次的虚拟文件已随内存丢失，让内核重新产出 */
  private async regenerateProposal(): Promise<void> {
    await this.send("请重新生成上一次的改动提案。", this.panel.getMode(), []);
  }

  /** 新建会话：换 id、清空面板、重开上下文 */
  private async newSession(): Promise<void> {
    await this.sessions.flush();
    this.sessionId = newSessionId();
    await this.context.globalState.update(SESSION_KEY, this.sessionId);
    this.summaryCache = undefined;
    this.turnIntent = undefined;
    this.turn = "idle";
    this.turnDetail = undefined;
    this.persisted = 0;
    this.panel.restore([], this.panel.getMode());
    this.sessions.create({
      id: this.sessionId,
      title: "新会话",
      mode: this.panel.getMode(),
      workspace: workspaceRoots()[0] ?? "",
      createdAt: Date.now(),
    });
    this.panel.setHint("已新建会话。");
  }

  /** 切换历史会话 */
  private async pickSession(): Promise<void> {
    const items = this.sessions.list().map((meta) => ({
      label: meta.title,
      description: `${new Date(meta.updatedAt).toLocaleString()} · ${meta.messageCount} 条`,
      detail: meta.id,
      id: meta.id,
    }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage("Bee Code: 还没有历史会话。");
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: "Bee Code · 历史会话",
      placeHolder: "选择要恢复的会话",
    });
    if (!picked || picked.id === this.sessionId) return;

    await this.sessions.flush();
    this.sessionId = picked.id;
    await this.context.globalState.update(SESSION_KEY, this.sessionId);
    this.summaryCache = undefined;
    this.turnIntent = undefined;
    this.persisted = 0;
    const messages = await this.sessions.open(picked.id);
    this.panel.restore(
      messages.map((m) => ({ id: m.id, role: m.role, text: m.text })),
      this.sessions.meta(picked.id)?.mode ?? this.panel.getMode(),
    );
    this.persisted = messages.length;
    this.panel.setPlan(this.sessions.meta(picked.id)?.plan);
    await this.loadSummary(messages.length);
    await this.refreshTrajectory();
    this.panel.setHint(`已切换到会话「${picked.label}」（${messages.length} 条消息）。`);
    this.panel.pushState();
  }
  // ───────────────────────── 内核生命周期 ─────────────────────────

  private async ensureCore(): Promise<CoreApi> {
    if (this.core?.alive) return this.core;
    if (this.starting) return this.starting;
    // 停用后（含 deactivate 之后 VS Code 仍在回收 subscriptions 的窗口）绝不再拉起内核
    if (this.disposed) throw new Error("Bee Code 已停用");

    this.starting = (async () => {
      let core: CoreApi;
      try {
        core = this.config.coreMode === "mock" ? new MockCore(this.log, () => this.firstWorkspaceFile()) : this.createPythonCore();
      } catch (err) {
        if (err instanceof CoreNotFoundError) {
          // 安装模式下最常见的失败：扩展目录里没有 beecode 包
          this.panel.setHint("找不到内核：请在工作区开发 beecode，或设置 beeCode.core.coreRoot");
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
          text: `内核已退出（${reason}，code=${code ?? "?"}）。可运行「Bee Code: 重启内核进程」重试。`,
        });
        this.updateStatus();
      });

      const resolvedKey = await this.resolveApiKey();
      const subagent = this.effectiveSubagent();
      const subagentKey = await this.resolveSubagentKey();
      const params: InitializeParams = {
        protocolVersion: PROTOCOL_VERSION,
        workspaceRoots: workspaceRoots(),
        modelConfig: this.config.model,
        maxSteps: this.config.maxSteps,
        toolTimeoutMs: this.config.toolTimeoutMs,
        largeTaskSteps: this.config.largeTaskSteps,
        maxTurnTokens: this.config.maxTurnTokens,
        maxTurnSeconds: this.config.maxTurnSeconds,
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
      };

      await core.initialize(params);
      this.core = core;
      this.log.info(`内核就绪（${core.kind}）`);
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
    // 开发时内核在工作区、打包后内核在扩展目录 —— 由 locator 决定，别写死 cwd
    const spec = locateCore({
      configuredRoot: this.config.coreRoot,
      configuredArgs: this.config.coreArgs,
      workspaceRoot: workspaceRoots()[0],
      extensionPath: this.context.extensionUri.fsPath,
      cwdOverride: this.config.cwd,
    });

    this.log.info(`内核定位：${describeLaunch(spec)}（PYTHONPATH=${spec.env["PYTHONPATH"] ?? ""}）`);
    const core = new PythonCore({
      pythonPath: this.config.pythonPath,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      logger: this.log,
    });
    core.setRequestHandler(this.server.handle);
    return core;
  }

  private async restartCore(): Promise<void> {
    if (this.disposed) return;   // 停用中不再拉起新进程
    if (this.core) {
      await this.core.shutdown().catch(() => undefined);
      this.core.dispose();
      this.core = undefined;
    }
    this.panel.addMessage({ id: `sys_${Date.now()}`, role: "system", text: "内核已重启。" });
    this.panel.setHint(this.hintForState());
    this.updateStatus();
  }

  private async abort(): Promise<void> {
    const core = this.core;
    if (!core) return;
    await core.abort(this.sessionId).catch((err: unknown) => {
      this.log.warn(`abort 失败: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.busy = false;
    this.panel.setBusy(false);
    this.updateStatus();
  }

  // ───────────────────────── 用户动作 ─────────────────────────

  private async send(text: string, mode: Mode, attachments: AttachedContext[], autoFocus = true): Promise<void> {
    if (this.disposed) return;
    if (this.busy) {
      this.panel.setHint("上一轮还没结束（可点 ■ 停止）");
      return;
    }

    // 没有工作区就没有代码可读、没有检查点可落 —— 先说清楚，而不是让内核抛 ModuleNotFound
    if (isWorkspaceEmpty()) {
      await this.promptOpenWorkspace();
      return;
    }

    const trimmed = text.trim();
    this.focusHighlight.clear();

    // 用户没手动附加时，自动附上"光标所在的整个函数"（不在函数里就上下 N 行）
    let effectiveAttachments = attachments;
    let focus: FocusInfo | undefined;
    if (autoFocus && attachments.length === 0 && this.config.focus.autoAttach) {
      focus = await readFocusAtCursor({
        fallbackLines: this.config.focus.fallbackLines,
        maxLines: this.config.focus.maxLines,
      }).catch((err: unknown) => {
        this.log.debug(`读取光标位置失败: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
      if (focus) {
        effectiveAttachments = [toFocusContext(focus)];
        if (this.config.focus.highlight) this.focusHighlight.show(focus);
        this.log.info(
          `自动附加光标代码：${focus.path}:${focus.startLine}-${focus.endLine}（${focus.kind}${focus.symbol ? ` ${focus.symbol}` : ""}）`,
        );
      }
    }

    if (trimmed.length === 0 && effectiveAttachments.length === 0) return;

    const userText = trimmed || defaultInstruction(mode);
    const userMessageId = `u_${Date.now()}`;
    this.turnUserMessageId = userMessageId;
    this.panel.addMessage({ id: userMessageId, role: "user", text: userText });
    this.panel.setCost("");
    this.remember("user", userText);
    this.setBusy(true);
    this.assistantBuffer = "";
    this.turnIntent = undefined;
    this.turnTools.clear();
    this.turnObservations.length = 0;
    this.turnFiles.clear();
    this.turnPlan = [];
    this.turn = "thinking";
    this.turnDetail = undefined;
    void this.sessions.updateStatus(this.sessionId, "thinking");

    try {
      const core = await this.ensureCore();
      const meta = this.sessions.meta(this.sessionId);
      // 历史是**裁剪过**的：摘要 + 最近 N 条，而不是整份 transcript
      const ctx = await this.modelContext();
      const params: ChatSendParams = {
        sessionId: this.sessionId,
        mode,
        text: userText,
        attachments: effectiveAttachments.map(toAttachment),
        ...(focus ? { focus: focusDto(focus) } : {}),
        // 本轮用户消息已经通过 text 单独传，别在 history 里重复一次
        history: stripTrailingUser(ctx.history, userText),
        summary: ctx.summary,
        // 上一轮未完成的计划：跨轮延续（全部完成就不带了）
        ...(pendingPlan(meta?.plan) ? { plan: pendingPlan(meta?.plan) } : {}),
      };
      await core.chatSend(params);
    } catch (err) {
      this.panel.addMessage({
        id: `e_${Date.now()}`,
        role: "system",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const assistantText = this.assistantBuffer;
      if (assistantText.trim()) {
        // 先写进面板 state：pushState 会按 state 重渲染，不写的话回合结束时回复会「消失」
        this.panel.addMessage({ id: `a_${Date.now()}`, role: "assistant", text: assistantText });
        this.remember("assistant", assistantText);
        this.assistantBuffer = "";
      }
      // 落盘轮次记录（意图 + 回答 + 工具 + 文件），供上下文压缩时按意图总结
      await this.appendTurn(userText, assistantText, mode).catch((err: unknown) => {
        this.log.warn(`轮次记录失败：${err instanceof Error ? err.message : String(err)}`);
      });
      this.setBusy(false);
      this.turn = this.proposals.count() > 0 ? "awaiting-decision" : "idle";
      void this.sessions.updateStatus(this.sessionId, this.turn);
      this.panel.pushState();
    }
  }

  /** 接受一个或多个提案：逐个 拉正文 → 写盘 → 通知内核 */
  private async acceptProposals(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const failed: string[] = [];
    for (const id of ids) {
      const result = await this.acceptOne(id);
      if (!result) failed.push(id);
    }
    this.refreshProposals();
    if (failed.length > 0) {
      void vscode.window.showWarningMessage(`Bee Code: ${failed.length} 个提案没能应用（详见输出面板）。`);
    }
  }

  private async acceptOne(id: string): Promise<boolean> {
    let core: CoreApi;
    try {
      core = await this.ensureCore();
    } catch (err) {
      this.log.error("接受提案失败：内核不可用", err instanceof Error ? err.message : String(err));
      return false;
    }

    const dto = this.proposals.get(id);
    if (!dto) return false;

    // ① 权限门闸（用户已点"接受"，但没有 deny 规则 / 未受信任时仍然拒绝）
    try {
      await this.assertWriteAllowed(dto.path, localContext(), { userApproved: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`提案 ${id} 被权限拒绝：${message}`);
      void vscode.window.showWarningMessage(`Bee Code: ${message}`);
      return false;
    }

    // ② 写入前自动快照：不再依赖内核"记得调 checkpoint"
    if (this.config.checkpointEnabled) {
      const checkpoint = await this.checkpoint.create({ label: `accept ${dto.path}` }).catch(() => undefined);
      if (checkpoint?.id) {
        this.log.debug(`自动检查点 ${checkpoint.id.slice(0, 8)}（${dto.path}）`);
        // 代码快照的同时快照聊天记录：回滚时可以选"代码 + 聊天一起回"
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
      this.log.info(`提案已应用 ${id}`);
      this.panel.planStepDone(dto.path);
      const plan = this.panel.getPlan();
      if (plan) this.sessions.updatePlan(this.sessionId, plan);
      return true;
    }
    this.log.warn(`提案未应用 ${id}（${dto.path}）：${result.message ?? "未知原因"}`);
    if (result.conflict) {
      this.proposals.markStale(id);
      void vscode.window.showWarningMessage(
        `Bee Code: ${dto.path} 已被修改，提案未应用。请让 agent 重新生成。`,
      );
    }
    return false;
  }

  private async rejectProposals(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
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
      this.panel.setHint("没有待处理的提案。");
      return;
    }
    // 批量接受可能很久（每个提案要拉正文 + 写盘）：允许中途取消
    this.acceptAllCancelled = false;
    const token = ++this.acceptAllToken;
    this.panel.setHint(`正在接受 ${ids.length} 个提案…（可运行「取消批量接受」）`);
    for (const id of ids) {
      if (this.acceptAllCancelled || token !== this.acceptAllToken) break;
      await this.acceptOne(id);
      this.refreshProposals();
    }
    this.panel.setHint(this.acceptAllCancelled ? "已取消批量接受（已完成的不会回滚）。" : undefined);
    this.refreshProposals();
  }

  /** 「取消批量接受」命令：不中断正在写的那一个，但不再继续下一个 */
  private cancelAcceptAll(): void {
    this.acceptAllCancelled = true;
    this.acceptAllToken += 1;
    this.log.info("用户取消了批量接受");
  }

  private async rejectAllProposals(): Promise<void> {
    const ids = this.proposals.pending().map((p) => p.id);
    await this.rejectProposals(ids);
  }

  /** 打开某个提案的 diff：左=磁盘现状，右=提案内容 */
  private async showProposal(id: string): Promise<void> {
    const core = await this.ensureCore().catch(() => undefined);
    if (!core) return;
    const opened = await this.proposals.show(id, async (proposalId) => (await core.proposalRead({ id: proposalId })).text);
    if (!opened) void vscode.window.showWarningMessage("Bee Code: 无法打开提案预览。");
  }

  /** mock 的提案指向一个真实存在的文件，否则点「查看」会看到空 diff */
  private async firstWorkspaceFile(): Promise<string | undefined> {
    const found = await vscode.workspace.findFiles("**/*.{ts,tsx,js,jsx,py,md}", "**/node_modules/**", 1);
    const uri = found[0];
    return uri ? toWorkspaceRelative(uri.fsPath) : undefined;
  }

  // ───────────────────────── 权限 ─────────────────────────

  /** 重新读取权限规则与信任状态（启动 + 配置变更时调用） */
  // ───────────────────────── 沙箱 ─────────────────────────

  /**
   * 启动时检测 docker；不可用时**只在第一次 / 配置变化时**询问，
   * 之后静默按"无沙箱策略"运行（避免每次启动都弹窗）。
   */
  private async initSandbox(force = false): Promise<void> {
    const detected = await detectDocker();
    this.dockerAvailable = detected;
    const fingerprint = `${this.config.permissions.sandbox}|${this.config.permissions.dockerImage}`;
    const recorded = this.context.globalState.get<{ choice?: "yes" | "no"; fingerprint?: string }>("beeCode.docker");

    if (detected) {
      this.log.info("docker 可用：命令将在沙箱内执行");
      await this.context.globalState.update("beeCode.docker", { choice: "yes", fingerprint });
      if (force || recorded?.choice !== "yes") {
        void vscode.window.showInformationMessage("Bee Code: 已检测到 Docker，命令将在沙箱内执行。");
      }
      return;
    }

    const askedBefore = recorded?.choice !== undefined && recorded.fingerprint === fingerprint;
    if (askedBefore && !force) {
      this.log.info("docker 不可用（此前已提示过）：按无沙箱策略运行");
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      "Bee Code: 没有检测到 Docker。\n\n" +
        "· 有 Docker：命令在隔离容器内执行，子代理也能执行命令。\n" +
        "· 没有 Docker：每条命令都需要你确认；子代理不能执行命令或写文件。",
      "我有 Docker（重新检测）",
      "我没有 Docker",
      "稍后再说",
    );

    if (choice === "我有 Docker（重新检测）") {
      const again = await detectDocker();
      this.dockerAvailable = again;
      if (again) {
        await this.context.globalState.update("beeCode.docker", { choice: "yes", fingerprint });
        void vscode.window.showInformationMessage("Bee Code: 已检测到 Docker，命令将在沙箱内执行。");
        return;
      }
      void vscode.window.showWarningMessage("Bee Code: 仍然没有检测到 Docker，按无沙箱策略运行。");
    }

    if (choice !== undefined) {
      await this.context.globalState.update("beeCode.docker", {
        choice: choice === "我没有 Docker" ? "no" : undefined,
        fingerprint,
      });
    }
    this.log.info(`docker 不可用：${this.dockerAvailable ? "?" : "无沙箱策略"}`);
  }

  private async redetectSandbox(): Promise<void> {
    await this.initSandbox(true);
  }

  /** 统一的策略判定（纯函数在 policy.ts，这里只注入上下文） */
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

  /** 工作区外路径：先确认再放行；批准后把目录记入内存（重启失效） */
  private async ensurePathAccess(rawPath: string, ctx: InboundRequestContext, role: AgentRole): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw deniedError("未打开工作区");
    const absolute = nodePath.isAbsolute(rawPath) ? nodePath.resolve(rawPath) : nodePath.resolve(root, rawPath);
    if (isInside(root, absolute)) return;

    const decision = this.policyFor("read", { role, insideWorkspace: false });
    if (decision.decision === "deny") throw deniedError(decision.reason);

    const answer = await this.confirm.ask(
      {
        question: "允许访问工作区外的路径？",
        detail: `${absolute}\n\n${decision.reason}`,
        options: [
          { id: "yes", label: "允许" },
          { id: "no", label: "拒绝" },
        ],
        rememberKey: `path:${nodePath.dirname(absolute)}`,
      },
      ctx,
    );
    if (answer.choice !== "yes") throw deniedError("用户拒绝访问工作区外路径");
    addApprovedRoot(nodePath.dirname(absolute));
  }

  private async refreshPermissions(): Promise<void> {
    this.rules = buildRuleSet(this.config.permissions);
    this.trusted = this.config.permissions.requireTrust
      ? await ensureWorkspaceTrust(this.context, this.log)
      : vscode.workspace.isTrusted;
    this.log.info(
      `权限：mode=${this.config.permissions.mode} trusted=${this.trusted} ` +
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
   * 写入门闸。
   *
   * `userApproved` = 用户刚在提案里点了「接受」。区分它，是为了避免"点一次接受又问一次"：
   *   - deny → 拒绝（无论如何）
   *   - 显式 ask 规则 → 永远确认（用户明确要求每写必问）
   *   - 模式默认 ask → 提案路径视为已确认；内核直接调 edit.apply 时仍要确认
   *   - 敏感路径 + 模式放行 → 确认一次（模式放行 ≠ 用户知情）
   */
  /**
   * 写入门闸。
   *
   * 三层叠加：沙箱策略（policy.ts）→ 规则引擎（permissions.ts）→ 敏感路径二次确认。
   * `userApproved` = 用户刚在提案里点了「接受」，用来避免"点一次接受又问一次"。
   */
  private async assertWriteAllowed(
    rawPath: string,
    ctx: InboundRequestContext,
    opts: { userApproved: boolean; role?: AgentRole },
  ): Promise<void> {
    const role: AgentRole = opts.role ?? "main";
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw deniedError("未打开工作区");
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
        question: `允许修改 ${rawPath}？`,
        detail: `${policy.reason}\n${evaluation.reason}\n\n路径：${rawPath}`,
        options: [
          { id: "yes", label: "允许" },
          { id: "no", label: "拒绝" },
        ],
        rememberKey: `write:${rawPath}`,
      },
      ctx,
    );
    if (answer.choice !== "yes") throw deniedError("用户拒绝写入");
  }

  /**
   * 命令执行：
   *   - 有 docker → 一律在容器内执行（不管用户把 sandbox 设成 off 还是 auto）
   *   - 没有 docker → 主代理每条都要确认；子代理只允许只读命令
   */
  private async runCommand(params: RunParams, ctx: InboundRequestContext): Promise<RunResult> {
    const role: AgentRole = params.role === "subagent" ? "subagent" : "main";
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw deniedError("未打开工作区");

    const cwdAbs = params.cwd ? nodePath.resolve(root, params.cwd) : root;
    const inside = isInside(root, cwdAbs);
    const readOnly = isReadOnlyCommand(params.command);

    const policy = this.policyFor("run", { role, insideWorkspace: inside, readOnlyCommand: readOnly });
    if (policy.decision === "deny") throw deniedError(policy.reason);
    if (!inside) await this.ensurePathAccess(params.cwd ?? ".", ctx, role);

    const evaluation = this.describePermission("run", params.command);
    if (evaluation.decision === "deny") throw deniedError(evaluation.reason);

    const needAsk = policy.decision === "ask" || evaluation.decision === "ask";
    if (needAsk) {
      const answer = await this.confirm.ask(
        {
          question: "执行这条命令？",
          detail:
            `${policy.reason}\n${evaluation.reason}\n\n` +
            `${params.command}\n\n` +
            `沙箱：${this.dockerAvailable ? "docker" : "无（直接执行）"}`,
          options: [
            { id: "yes", label: "执行" },
            { id: "no", label: "取消" },
          ],
          // 无沙箱时每条都要问（不给"记住"）；有 docker 且非 fullAccess 时可记住
          rememberKey: this.dockerAvailable && !this.config.permissions.fullAccess ? `run:${params.command}` : undefined,
        },
        ctx,
      );
      if (answer.choice !== "yes") throw deniedError("用户取消执行");
    }

    return this.runner.run(params, ctx);
  }

  /** 点击「已读取文件」chip：打开文件并把光标放到对应行范围 */
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
      this.log.debug(`跳转到 ${path}:${start + 1}-${end + 1}`);

      // 跳转后重新画一次高亮：面板 chip 可能已经存在很久，实时高亮早就过期了。
      // addRead 自带 6 秒定时清除，且会去重（同一范围不会重复叠加）。
      if (this.config.focus.highlight) {
        this.focusHighlight.addRead({ path, startLine: start + 1, endLine: end + 1 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`打开 ${path} 失败：${message}`);
      void vscode.window.showWarningMessage(`Bee Code: 无法打开 ${path}（${message}）`);
    }
  }
  private async pickFiles(): Promise<void> {
    const found = await vscode.workspace.findFiles("**/*", undefined, 3000);
    const items = found
      .map((uri) => ({ label: toWorkspaceRelative(uri.fsPath), uri }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: "Bee Code · 选择要阅读的文件",
      placeHolder: "输入以筛选；回车确认（可多选）",
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
    this.panel.setHint(`已附加 ${picked.length} 个文件`);
  }

  /**
   * 解析 API Key：**SecretStorage 优先，环境变量兜底**。
   *
   * 为什么这个顺序：显式配置 > 环境默认。环境变量适合 CI / 不想把 key 存进凭据库的场景；
   * 但它对整个进程可见，所以永远排在 SecretStorage 之后。
   */
  private async resolveApiKey(): Promise<{ key?: string; source: "secret" | "env" | "none" }> {
    const fromSecret = await this.context.secrets.get(this.config.apiKeyId);
    if (fromSecret) return { key: fromSecret, source: "secret" };
    const fromEnv = process.env[API_KEY_ENV]?.trim();
    if (fromEnv) return { key: fromEnv, source: "env" };
    return { source: "none" };
  }

  /**
   * 解析子代理密钥：SecretStorage（`beeCode.subagent.apiKeyId`）→ 环境变量 → **主代理密钥**。
   *
   * 绝大多数情况用户只想"子代理用便宜模型，但仍用同一个 key"，所以最后一级回退到主代理是合理的。
   */
  private async resolveSubagentKey(): Promise<{ key?: string; source: "secret" | "env" | "main" | "none" }> {
    const fromSecret = await this.context.secrets.get(this.config.subagent.apiKeyId);
    if (fromSecret) return { key: fromSecret, source: "secret" };
    const fromEnv = process.env[SUBAGENT_API_KEY_ENV]?.trim();
    if (fromEnv) return { key: fromEnv, source: "env" };
    const main = await this.resolveApiKey();
    if (main.key) return { key: main.key, source: "main" };
    return { source: "none" };
  }

  /** 子代理实际生效的端点/模型（空 = 沿用主代理） */
  private effectiveSubagent(): { baseUrl: string; model: string; maxSteps: number; supportsVision: "auto" | "on" | "off"; enabled: boolean } {
    return {
      enabled: this.config.subagent.enabled,
      baseUrl: this.config.subagent.baseUrl.trim() || this.config.model.baseUrl,
      model: this.config.subagent.model.trim() || this.config.model.model,
      maxSteps: this.config.subagent.maxSteps,
      supportsVision: this.config.subagent.supportsVision,
    };
  }

  /** 把 base_url 归一化成 `.../models`（用于连通性自检） */
  private modelsUrl(baseUrl: string): string | undefined {
    const base = baseUrl.trim().replace(/\/+$/, "");
    if (!base) return undefined;
    if (base.endsWith("/chat/completions")) return base.replace(/\/chat\/completions$/, "/models");
    if (base.endsWith("/v1")) return `${base}/models`;
    return `${base}/models`;
  }

  /** 测试连接：GET {base}/models，把 HTTP 状态翻译成人话（main / subagent 共用） */
  private async testModel(which: "main" | "subagent" = "main"): Promise<void> {
    const label = which === "subagent" ? "子代理" : "主代理";
    const subagent = this.effectiveSubagent();
    const baseUrl = which === "subagent" ? subagent.baseUrl : this.config.model.baseUrl;
    const modelName = which === "subagent" ? subagent.model : this.config.model.model;
    const url = this.modelsUrl(baseUrl);
    if (!url) {
      void vscode.window.showWarningMessage(`Bee Code: ${label}还没有配置 base_url。`);
      return;
    }
    const keyInfo = which === "subagent" ? await this.resolveSubagentKey() : await this.resolveApiKey();
    if (!keyInfo.key) {
      void vscode.window.showWarningMessage(`Bee Code: ${label}还没有 API Key。`);
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
        this.log.warn(`${label}自检失败：HTTP ${response.status} ${url}（key 来源 ${source}）`);
        void vscode.window.showWarningMessage(`Bee Code: ${label}连接失败 HTTP ${response.status}（${elapsed}ms）：${body}`);
        return;
      }
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const count = Array.isArray(data.data) ? data.data.length : 0;
      const hasModel = Array.isArray(data.data) && data.data.some((m) => m.id === modelName);
      const sourceText =
        source === "env" ? "环境变量" : source === "main" ? "沿用主代理" : "凭据库";
      this.log.info(`${label}自检通过：${url}（${count} 个模型，key 来源 ${source}）`);
      void vscode.window.showInformationMessage(
        `Bee Code: ${label}连接正常（${elapsed}ms，${count} 个模型${hasModel ? `，包含 ${modelName}` : ""}；key 来源：${sourceText}）`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`${label}自检异常：${message}`);
      void vscode.window.showWarningMessage(`Bee Code: ${label}连接失败：${message}`);
    }
  }

  /** 配置子代理：终端可留空（= 沿用主代理），密钥可留空（= 沿用主代理密钥） */
  private async configureSubagent(): Promise<void> {
    const main = this.config.model;
    const current = this.config.subagent;

    const baseUrl = await vscode.window.showInputBox({
      title: "Bee Code · 子代理 1/3 端点",
      prompt: main.baseUrl
        ? `留空 = 沿用主代理（${main.baseUrl}）`
        : "OpenAI 兼容 base_url；留空 = 沿用主代理",
      value: current.baseUrl,
      ignoreFocusOut: true,
    });
    if (baseUrl === undefined) return;

    const model = await vscode.window.showInputBox({
      title: "Bee Code · 子代理 2/3 模型",
      prompt: main.model ? `留空 = 沿用主代理（${main.model}）；建议用便宜/快的模型` : "留空 = 沿用主代理",
      value: current.model,
      ignoreFocusOut: true,
    });
    if (model === undefined) return;

    const existing = await this.resolveSubagentKey();
    const keyHint =
      existing.source === "secret"
        ? "已存在于凭据库：直接回车保持不变"
        : existing.source === "env"
          ? `当前使用环境变量 ${SUBAGENT_API_KEY_ENV}：直接回车保持不变`
          : existing.source === "main"
            ? "留空 = 沿用主代理密钥"
            : "留空则回退到主代理密钥";

    const apiKey = await vscode.window.showInputBox({
      title: "Bee Code · 子代理 3/3 API Key",
      prompt: keyHint,
      password: true,
      ignoreFocusOut: true,
      placeHolder: existing.source === "none" ? "留空 = 沿用主代理密钥" : "（回车保持不变）",
      validateInput: (v) => (v.trim().length > 0 && v.trim().length < 8 ? "看起来不像有效密钥" : undefined),
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
      `子代理已配置：${this.effectiveSubagent().model} @ ${this.effectiveSubagent().baseUrl}`,
    );
    void vscode.window.showInformationMessage("Bee Code: 子代理配置完成。");

    // 只改了密钥时配置监听不会触发，这里主动热更新一次
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

  /** 清除子代理密钥（环境变量与"沿用主代理"不归我们管） */
  private async clearSubagentKey(): Promise<void> {
    const existing = await this.context.secrets.get(this.config.subagent.apiKeyId);
    if (!existing) {
      void vscode.window.showInformationMessage("Bee Code: 凭据库里没有子代理密钥（可能在环境变量里，或沿用了主代理）。");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      "确定清除子代理的 API Key？清除后将回退到环境变量或主代理密钥。",
      { modal: true },
      "清除",
    );
    if (confirm !== "清除") return;
    await this.context.secrets.delete(this.config.subagent.apiKeyId);
    this.log.info("已清除子代理 API Key");
    void vscode.window.showInformationMessage("Bee Code: 已清除子代理 API Key。");
  }

  /** 清除凭据库里的密钥（环境变量不归我们管） */
  private async clearModelKey(): Promise<void> {
    const existing = await this.context.secrets.get(this.config.apiKeyId);
    if (!existing) {
      void vscode.window.showInformationMessage("Bee Code: 凭据库里没有密钥（可能在环境变量里）。");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      "确定清除凭据库里保存的 API Key？清掉后需要重新配置（或改用环境变量）。",
      { modal: true },
      "清除",
    );
    if (confirm !== "清除") return;
    await this.context.secrets.delete(this.config.apiKeyId);
    this.log.info("已清除凭据库中的 API Key");
    void vscode.window.showInformationMessage("Bee Code: 已清除 API Key。");
  }

  private async configureModel(): Promise<void> {
    const baseUrl = await vscode.window.showInputBox({
      title: "Bee Code · 1/3 端点",
      prompt: "OpenAI 兼容 base_url（不含 /chat/completions）",
      value: this.config.model.baseUrl || "https://api.deepseek.com/v1",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length === 0 ? "不能为空" : undefined),
    });
    if (baseUrl === undefined) return;

    const model = await vscode.window.showInputBox({
      title: "Bee Code · 2/3 模型",
      prompt: "模型名，例如 deepseek-chat",
      value: this.config.model.model || "",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length === 0 ? "不能为空" : undefined),
    });
    if (model === undefined) return;

    // 已经配置过就允许"直接回车保持不变"——每次改端点都要重输 key 太烦
    const existing = await this.resolveApiKey();
    const keyHint =
      existing.source === "secret"
        ? "已存在于凭据库：直接回车保持不变"
        : existing.source === "env"
          ? `当前使用环境变量 ${API_KEY_ENV}：直接回车保持不变`
          : "仅存入 VS Code SecretStorage（OS 凭据库），不会写入 settings.json / 日志 / git";

    const apiKey = await vscode.window.showInputBox({
      title: "Bee Code · 3/3 API Key",
      prompt: keyHint,
      password: true,
      ignoreFocusOut: true,
      placeHolder: existing.source === "none" ? "粘贴你的 API Key" : "（回车保持不变）",
      validateInput: (v) => {
        const trimmed = v.trim();
        if (trimmed.length === 0) return existing.source === "none" ? "不能为空" : undefined;
        return trimmed.length < 8 ? "看起来不像有效密钥" : undefined;
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
    for (const problem of read.problems) this.log.warn(`配置有问题：${problem}`);
    this.log.info(`模型已配置：${this.config.model.model} @ ${this.config.model.baseUrl}（key 已入库）`);
    void vscode.window.showInformationMessage("Bee Code: 模型配置完成。");

    // 配置变更监听会走 modelReload（不重启进程），这里不重复调用
    const resolved = await this.resolveApiKey();
    if (this.core && resolved.key) {
      await this.core
        .modelReload({ modelConfig: this.config.model, apiKey: resolved.key })
        .catch(() => undefined);
    }
  }

  /**
   * 回滚到某个检查点。
   *
   * 两种语义（用户选）：
   *   - 仅代码：文件回到快照，聊天保留，**追加一条回滚通知**让模型知道
   *   - 代码 + 聊天：文件与对话一起回到快照时刻（JSONL 截断）
   *
   * 两种都会把目标之后的快照作废（影子仓库 HEAD 回退 + 删除对应聊天快照），
   * 之后的新快照从目标点继续。
   */
  private async restoreCheckpoint(): Promise<void> {
    const records = await this.checkpoint.list();
    if (records.length === 0) {
      void vscode.window.showInformationMessage("Bee Code: 还没有检查点（写入前会自动创建）。");
      return;
    }
    const snapshots = new Map((await this.chatIndex.list()).map((meta) => [meta.id, meta]));

    const items = records.map((record) => {
      const snap = snapshots.get(record.id);
      return {
        label: record.id.slice(0, 8),
        description: new Date(record.createdAt).toLocaleString(),
        detail: `${record.label}${snap ? ` · 含聊天快照（第 ${snap.line} 行）` : " · 无聊天快照"}`,
        id: record.id,
        hasChat: Boolean(snap),
        line: snap?.line ?? 0,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: "Bee Code · 恢复到检查点",
      placeHolder: "选择要回滚到的快照",
    });
    if (!picked) return;

    const modePick = await vscode.window.showQuickPick(
      [
        {
          label: "仅回滚代码",
          description: "保留当前聊天记录；模型会收到一条「代码已回滚」的通知",
          value: "code" as const,
        },
        {
          label: "代码 + 聊天记录一起回滚",
          description: picked.hasChat
            ? `对话回到快照时刻（第 ${picked.line} 行之前的记录）`
            : "该检查点没有聊天快照，只能回滚代码",
          value: "chat" as const,
          disabled: !picked.hasChat,
        },
      ],
      { title: "回滚范围", placeHolder: "代码和聊天记录要不要一起回退？" },
    );
    if (!modePick) return;
    const restoreChat = modePick.value === "chat";

    const confirm = await vscode.window.showWarningMessage(
      restoreChat
        ? "将覆盖当前工作区文件，并把聊天记录截断到该快照时刻。目标之后的所有快照会作废。继续？"
        : "将覆盖当前工作区文件（包括你自己的未提交修改）。目标之后的所有快照会作废。继续？",
      { modal: true },
      "回滚",
    );
    if (confirm !== "回滚") return;

    const result = await this.checkpoint.restore({ id: picked.id });
    const { voided } = await this.checkpoint.rewind(picked.id);
    await this.chatIndex.remove(voided);
    this.log.info(
      `回滚到 ${picked.id.slice(0, 8)}：恢复 ${result.restored.length} 个文件，作废 ${voided.length} 个后续快照`,
    );

    // 回滚后待审提案必然基于旧代码，直接清掉，避免误点「接受」
    this.proposals.clear();
    this.panel.setProposals(this.proposals.visible());

    if (restoreChat) {
      const snapshot = await this.chatIndex.load(picked.id);
      if (!snapshot || snapshot.sessionId !== this.sessionId) {
        void vscode.window.showWarningMessage("Bee Code: 聊天快照不可用（可能属于别的会话），本次只回滚了代码。");
        await this.noteRollback(picked.id, picked.label, false);
        return;
      }
      // 快照只存行号：截断 JSONL 到那一行，消息全文仍然只有一份
      const kept = await this.sessions.truncate(this.sessionId, snapshot.line);
      this.panel.restore(
        kept.map((m) => ({ id: m.id, role: m.role, text: m.text })),
        this.sessions.meta(this.sessionId)?.mode,
      );
      this.persisted = kept.length;
      // 轮次记录也截断到同一位置；摘要随之截断（已覆盖的轮次按 messageIndex 对齐）
      await this.turns.truncate(this.sessionId, snapshot.line);
      await this.truncateSummary(snapshot.line);
      const keptTurns = await this.turns.list(this.sessionId);
      const lastPlan = keptTurns[keptTurns.length - 1]?.plan;
      this.panel.setPlan(lastPlan);
      this.sessions.updatePlan(this.sessionId, lastPlan);
      await this.refreshTrajectory();
      this.turnIntent = undefined;
      void this.sessions.updateStatus(this.sessionId, "idle");
      await this.noteRollback(picked.id, picked.label, true);
      void vscode.window.showInformationMessage(
        `Bee Code: 已回滚代码与聊天记录（截断到第 ${snapshot.line} 行，恢复 ${result.restored.length} 个文件）。`,
      );
      return;
    }

    await this.noteRollback(picked.id, picked.label, false);
    void vscode.window.showInformationMessage(
      `Bee Code: 已回滚 ${result.restored.length} 个文件（聊天记录保留）。`,
    );
  }
  /** 回滚后写一条系统消息，并把它记成一轮"意图"，让后续摘要能覆盖这次回滚 */
  private async noteRollback(checkpointId: string, label: string, withChat: boolean): Promise<void> {
    const text = withChat
      ? `【回滚通知】已把代码与聊天记录一起回滚到检查点 ${checkpointId.slice(0, 8)}（${label}）。此前的对话记录已截断，请以当前文件内容为准。`
      : `【回滚通知】代码已回滚到检查点 ${checkpointId.slice(0, 8)}（${label}），聊天记录保留。` +
        "此前提到的文件改动可能已不在磁盘上；请以当前文件内容为准，需要时重新读取确认。";
    this.panel.addMessage({ id: `sys_${Date.now()}`, role: "system", text });
    this.remember("system", text);
    const all = await this.sessions.open(this.sessionId);
    await this.turns.append(this.sessionId, {
      intent: `把代码回滚到检查点 ${checkpointId.slice(0, 8)}${withChat ? "（含聊天记录）" : ""}`,
      mode: this.panel.getMode(),
      userText: "",
      assistant: text,
      tools: [],
      files: [],
      observations: [],
      ts: Date.now(),
      messageIndex: all.length,
    });
    this.log.info(`回滚通知已写入会话（${withChat ? "含聊天回滚" : "仅代码"}）`);
  }
  /**
   * 导出诊断包（已脱敏）。
   *
   * 落点：`<globalStorage>/diagnostics/` —— 扩展私有目录，不会被误提交进 git，
   * 也不在用户工作区里制造文件。用户要发 issue 时再「另存为…」到桌面/文档。
   */
  private async exportDiagnostics(): Promise<void> {
    const uri = await writeDiagnostics({
      context: this.context,
      logger: this.log,
      config: this.config,
      coreKind: this.core?.kind ?? this.config.coreMode,
    });
    const name = nodePath.basename(uri.fsPath);

    const choice = await vscode.window.showInformationMessage(
      `Bee Code: 诊断包已生成（已脱敏）— ${name}`,
      "打开所在文件夹",
      "另存为…",
    );
    if (choice === "打开所在文件夹") {
      await vscode.commands.executeCommand("revealFileInOS", uri);
      return;
    }
    if (choice === "另存为…") {
      const target = await vscode.window.showSaveDialog({
        title: "另存诊断包",
        defaultUri: vscode.Uri.file(nodePath.join(os.homedir(), name)),
        filters: { Markdown: ["md"] },
      });
      if (!target) return;
      await vscode.workspace.fs.copy(uri, target, { overwrite: true });
      void vscode.window.showInformationMessage(`已保存到 ${target.fsPath}`);
    }
  }

  // ───────────────────────── 内核通知 ─────────────────────────

  private onCoreNotification(method: string, params: unknown): void {
    switch (method) {
      case "ui.delta": {
        const p = params as UiDeltaParams;
        this.assistantBuffer += p.text;   // 落盘用（面板的流式展示是另一条通路）
        this.panel.appendDelta(p.text);
        return;
      }
      case "ui.tool": {
        const tool = params as UiToolParams;
        if (tool.status === "start" && tool.name !== "model" && tool.name !== "guard") {
          this.turnTools.add(tool.name);
        }
        if (tool.status !== "start" && tool.name !== "model" && tool.name !== "guard") {
          const note = `${tool.name}${tool.summary ? `: ${tool.summary}` : ""}`;
          this.turnObservations.push(note);
          if (this.turnObservations.length > 12) this.turnObservations.shift();
        }
        if (tool.status === "start") {
          this.turn = "tool";
          this.turnDetail = tool.name;
          void this.sessions.updateStatus(this.sessionId, "thinking");
        }
        const p = params as UiToolParams;
        this.panel.setHint(`${p.status === "start" ? "运行" : p.status === "end" ? "完成" : "失败"}：${p.name}`);
        return;
      }
      case "ui.read": {
        const p = params as UiReadParams;
        this.panel.readEvent(p);
        const name = p.path.split("/").pop() || p.path;
        const drawn = this.config.focus.highlight ? this.focusHighlight.addRead(p) : false;
        this.panel.setHint(
          drawn && p.startLine && p.endLine
            ? `读取 ${name}:${p.startLine}-${p.endLine}`
            : `读取 ${name}`,
        );
        return;
      }
      case "ui.intent": {
        const p = params as UiIntentParams;
        // 意图分析本身不展示（不产生消息）；面板只更新模式徽标与提示
        this.turnIntent = { intent: p.intent, mode: p.mode };
        this.panel.setMode(p.mode);
        const label = p.mode === "builder" ? "Builder" : p.mode === "debugger" ? "Debugger" : "Chat";
        const flags = [
          p.scale === "large" ? "大任务" : "",
          p.needsProposal ? "需产出提案" : "",
          p.degraded ? "降级判定" : "",
          p.reused ? "沿用上轮意图" : "",
        ].filter(Boolean);
        this.panel.setHint(`${label}${flags.length ? `（${flags.join("，")}）` : ""} · ${p.reason ?? ""}`);
        if (this.turnUserMessageId) {
          this.panel.addTrajectoryItem({
            id: this.turnUserMessageId,
            mode: p.mode,
            intent: p.intent || p.reason || "（未记录意图）",
          });
        }
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
          this.panel.setHint(`子代理：${p.task ?? ""}`);
        } else if (p.status === "tool" && p.tool) {
          this.panel.setHint(`子代理 · ${p.tool.name}${p.tool.summary ? ` ${p.tool.summary}` : ""}`);
        } else if (p.status === "end") {
          this.panel.setHint(
            p.error ? `子代理失败：${p.error}` : `子代理完成（${p.steps ?? 0} 步 / ${p.toolCalls ?? 0} 次工具）`,
          );
        }
        return;
      }
      case "ui.usage": {
        const p = params as UiUsageParams;
        const cost = typeof p.costUsd === "number" ? ` · $${p.costUsd.toFixed(4)}` : "";
        this.usage = `${p.inputTokens ?? 0}→${p.outputTokens ?? 0} tok${cost}`;
        const tokens = (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
        const seconds = (p.elapsedMs ?? 0) / 1000;
        const nearTokens = tokens > this.config.maxTurnTokens * 0.8;
        const nearTime = seconds > this.config.maxTurnSeconds * 0.8;
        const fmtTokens = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
        this.panel.setCost(
          `${fmtTokens} tok · ${seconds.toFixed(1)}s${nearTokens || nearTime ? " · ⚠ 接近预算" : ""}`,
        );
        this.updateStatus();
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
        this.log[level](`[内核] ${p.msg ?? ""}`);
        return;
      }
      default:
        this.log.debug(`未处理的内核通知: ${method}`);
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
    this.panel.setProposals(this.proposals.visible());
    this.updateStatus();
  }

  // ───────────────────────── 适配器注册 ─────────────────────────

  private registerAdapters(): void {
    const fs = createFsAdapter(this.log);
    const search = createSearchAdapter(this.log);
    const symbols = createSymbolsAdapter(this.log);
    const diagnostics = createDiagnosticsAdapter(this.log);
    const secrets = createSecretAdapter(this.context, this.log);

    // 泛型 register：方法名与参数/返回类型强绑定，写错编译期就报
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
    this.server.register("checkpoint.create", (params) => this.checkpoint.create(params));
    this.server.register("checkpoint.restore", (params) => this.checkpoint.restore(params));
    this.server.register("diff.open", (params) => this.diff.open(params));
    this.server.register("secrets.get", (params) => secrets.get(params));
    this.server.register("confirm.ask", (params, ctx) => this.confirm.ask(params, ctx));

    // 用 info 而不是 debug：log channel 默认级别是 info，debug 会被过滤掉
    this.log.info(`已注册 RPC 方法: ${this.server.listed().join(", ")}`);

    this.verifyProtocolContract();
  }

  /**
   * 命令对账：已注册 ↔ package.json 声明。两边不一致时命令面板会静默缺项 / 点击报错。
   */
  private verifyCommands(registered: string[]): void {
    const problems = undeclaredCommands(this.context, registered);
    if (problems.length === 0) {
      this.log.info(`命令对账通过（${registered.length} 个）`);
      return;
    }
    for (const problem of problems) this.log.error(`命令对账：${problem}`);
    void vscode.window.showWarningMessage(`Bee Code: 命令声明与注册不一致（${problems.length} 处），详见输出面板。`);
  }

  /**
   * 协议自检：把「运行时注册的方法」与 `protocol/contract.json` 对账。
   *
   * 这是唯一能发现「TS 侧加了方法但 Python 契约没跟上」（或反之）的机制——
   * 类型在编译后消失，Python 也看不到 TypeScript，只能靠这份 JSON 做共同真相。
   * 失败不阻塞启动（可能是工作区里没有契约文件），但会显著地提示。
   */
  private verifyProtocolContract(): void {
    const check = loadContract([
      this.context.extensionUri.fsPath,
      workspaceRoots()[0],
      process.cwd(),
    ]);
    if (!check.contract) {
      for (const problem of check.problems) this.log.warn(`协议契约：${problem}`);
      return;
    }
    const problems = verifyRegistration(check.contract, this.server.listed());
    if (problems.length === 0) {
      this.log.info(`协议契约校验通过（version=${check.contract.version}, ${this.server.listed().length} 个方法）`);
      return;
    }
    for (const problem of problems) this.log.error(`协议契约不一致：${problem}`);
    void vscode.window.showWarningMessage(
      `Bee Code: 协议契约与实际注册不一致（${problems.length} 处），详见输出面板。`,
    );
  }

  // ───────────────────────── 杂项 ─────────────────────────

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.panel.setBusy(busy);
    this.updateStatus();
  }

  private updateStatus(): void {
    const pendingCount = this.proposals.count();
    const parts = [`$(bee) Bee Code`];
    if (this.busy) parts.push("$(sync~spin)");
    if (pendingCount > 0) parts.push(`待审 ${pendingCount}`);
    if (this.usage) parts.push(this.usage);
    this.status.text = parts.join(" · ");
    this.status.tooltip = `${describeConfig(this.config)}\n点击打开面板`;
  }

  private hintForState(): string {
    if (isWorkspaceEmpty()) return "请先打开一个工作区（文件夹），否则无法读取代码。";
    const missing: string[] = [];
    if (!this.config.model.baseUrl) missing.push("base_url");
    if (!this.config.model.model) missing.push("model");
    if (missing.length > 0) return `未配置 ${missing.join(" / ")}：运行「Bee Code: 配置模型」`;
    const keySource = process.env[API_KEY_ENV] ? " · 密钥来自环境变量" : "";
    return `内核模式：${this.config.coreMode}${keySource}`;
  }

  /**
   * 没有工作区时的统一引导：面板里留一条记录 + 弹一次带操作按钮的提示。
   *
   * 为什么不让它直接失败：内核拿不到 workspaceRoots 时，读文件/落检查点/diff
   * 全都会以「路径越界」「找不到工作区」这类间接错误暴露，用户根本猜不到原因。
   */
  private async promptOpenWorkspace(): Promise<void> {
    const message = "Bee Code: 请先打开一个工作区（文件夹），扩展需要它来读取代码与保存检查点。";
    this.panel.addMessage({ id: `sys_${Date.now()}`, role: "system", text: message });
    this.panel.setHint("未打开工作区");

    const choice = await vscode.window.showWarningMessage(message, "打开文件夹", "稍后");
    if (choice === "打开文件夹") {
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
 * 历史末尾若正好是本轮用户输入，去掉它。
 *
 * 壳先把用户消息写进会话存储、再构建上下文，所以 `history` 的最后一条就是本轮输入；
 * 而 `text` 又会单独传一次。不去重的话内核会收到两份同样的用户消息。
 */
function stripTrailingUser(history: ChatMessage[], text: string): ChatMessage[] {
  const last = history[history.length - 1];
  if (last && last.role === "user" && last.text.trim() === text.trim()) {
    return history.slice(0, -1);
  }
  return history;
}

/** 未完成的计划（全部 done 就没必要再带给模型） */
function pendingPlan(plan: PlanStep[] | undefined): PlanStep[] | undefined {
  if (!plan || plan.length === 0) return undefined;
  return plan.some((step) => step.status !== "done") ? plan : undefined;
}

/** 权限拒绝：用 PathPolicyError 这个 name，让壳的 rpcCodeFor 映射成 DENIED(-32013) */
function deniedError(reason: string): Error {
  const err = new Error(reason);
  err.name = "PathPolicyError";
  return err;
}

/** 本地动作（非 RPC 触发）用的上下文：不可取消 */
function localContext(): InboundRequestContext {
  return {
    id: "local",
    signal: new AbortController().signal,
    throwIfCancelled() {
      /* 本地动作不可取消 */
    },
  };
}

/** FocusInfo → 面板附件（kind=focus，内核据此生成"光标附近"标题） */
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

/** FocusInfo → 协议里的 FocusDto（不含正文，正文走 attachment） */
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