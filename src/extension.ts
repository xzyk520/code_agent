import * as os from "node:os";
import * as path from "node:path";
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
import { defaultInstruction, describeConfig, isWorkspaceEmpty, newSessionId, readConfig, workspaceRoots, type ShellConfig } from "./config";
import { loadContract, verifyRegistration } from "./contract";
import type { CoreApi } from "./coreApi";
import { CoreNotFoundError, describeLaunch, locateCore } from "./coreLocator";
import { exportDiagnostics as writeDiagnostics } from "./diagnostics";
import { MockCore } from "./dev/mockCore";
import { Logger } from "./log";
import { ChatViewProvider, type AttachedContext } from "./panel/chatViewProvider";
import { toWorkspaceRelative } from "./paths";
import { buildContext } from "./contextBuilder";
import { SessionStore, type TurnStatus } from "./sessionStore";
import type {
  Attachment,
  ChatSendParams,
  InitializeParams,
  LogParams,
  Mode,
  ChatMessage,
  ProposalChangedParams,
  ProposalDto,
  UiDeltaParams,
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
  private summary: string | undefined;
  /** 本轮助手输出（ui.delta 累积；chatSend 结束后整段落盘） */
  private assistantBuffer = "";
  private acceptAllCancelled = false;
  private acceptAllToken = 0;
  private readonly proposals: ProposalAdapter;
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
    this.proposals = new ProposalAdapter(this.diff, this.edit, this.log);
    this.sessions = new SessionStore(path.join(context.globalStorageUri.fsPath, "sessions"), this.log);
    this.sessionId = context.globalState.get<string>(SESSION_KEY) ?? newSessionId();

    this.panel = new ChatViewProvider(context.extensionUri, {
      onSend: (text, mode, attachments) => void this.send(text, mode, attachments),
      onAccept: (ids) => void this.acceptProposals(ids),
      onReject: (ids) => void this.rejectProposals(ids),
      onAcceptAll: () => void this.acceptAllProposals(),
      onRejectAll: () => void this.rejectAllProposals(),
      onShowProposal: (id) => void this.showProposal(id),
      onAbort: () => void this.abort(),
    });

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = "beeCode.chat.ask";
    this.status.show();

    this.registerAdapters();
  }

  async start(): Promise<void> {
    this.log.info(`激活：${describeConfig(this.config)}`);

    await this.ensureSession();

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
      pickSession: () => this.pickSession(),
      clearRemembered: () => {
        clearRememberedChoices(this.context);
        void vscode.window.showInformationMessage("Bee Code: 已清除记住的确认选择。");
      },
      pickFiles: () => this.pickFiles(),
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
        // 内核持有 modelConfig 与检查点开关，改配置后直接重启最省心
        void this.restartCore();
      }),
    );

    this.context.subscriptions.push(this.status, this.log, this.diff, this.checkpoint, this.proposals, this.sessions);
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
    const built = buildContext(all, this.summary);
    if (built.summary) this.summary = built.summary;
    if (built.folded > 0) {
      this.log.debug(`上下文裁剪：折叠 ${built.folded} 条，约 ${built.estimatedTokens} tokens`);
    }
    return { summary: built.summary, history: built.messages };
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
    this.summary = undefined;
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
    this.summary = undefined;
    this.persisted = 0;
    const messages = await this.sessions.open(picked.id);
    this.panel.restore(
      messages.map((m) => ({ id: m.id, role: m.role, text: m.text })),
      this.sessions.meta(picked.id)?.mode ?? this.panel.getMode(),
    );
    this.persisted = messages.length;
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
        core = this.config.coreMode === "mock" ? new MockCore(this.log) : this.createPythonCore();
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

      const apiKey = await this.context.secrets.get(this.config.apiKeyId);
      const params: InitializeParams = {
        protocolVersion: 1,
        workspaceRoots: workspaceRoots(),
        modelConfig: this.config.model,
        maxSteps: this.config.maxSteps,
        toolTimeoutMs: this.config.toolTimeoutMs,
        checkpointEnabled: this.config.checkpointEnabled,
        ...(apiKey ? { apiKey } : {}),
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

  private async send(text: string, mode: Mode, attachments: AttachedContext[]): Promise<void> {
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
    if (trimmed.length === 0 && attachments.length === 0) return;

    const userText = trimmed || defaultInstruction(mode);
    this.panel.addMessage({ id: `u_${Date.now()}`, role: "user", text: userText });
    this.remember("user", userText);
    this.setBusy(true);
    this.assistantBuffer = "";
    this.turn = "thinking";
    this.turnDetail = undefined;
    void this.sessions.updateStatus(this.sessionId, "thinking");

    try {
      const core = await this.ensureCore();
      // 历史是**裁剪过**的：摘要 + 最近 N 条，而不是整份 transcript
      const ctx = await this.modelContext();
      const params: ChatSendParams = {
        sessionId: this.sessionId,
        mode,
        text: userText,
        attachments: attachments.map(toAttachment),
        history: ctx.history,
        summary: ctx.summary,
      };
      await core.chatSend(params);
    } catch (err) {
      this.panel.addMessage({
        id: `e_${Date.now()}`,
        role: "system",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.setBusy(false);
      this.turn = this.proposals.count() > 0 ? "awaiting-decision" : "idle";
      void this.sessions.updateStatus(this.sessionId, "thinking");
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

    const result = await this.proposals.accept(
      id,
      async (proposalId) => (await core.proposalRead({ id: proposalId })).text,
      (proposalId, decision) => core.proposalDecide({ id: proposalId, decision }),
    );

    if (result.applied) {
      this.log.info(`提案已应用 ${id}`);
      return true;
    }
    const dto = this.proposals.get(id);
    this.log.warn(`提案未应用 ${id}（${dto?.path ?? "?"}）：${result.message ?? "未知原因"}`);
    if (result.conflict) {
      this.proposals.markStale(id);
      void vscode.window.showWarningMessage(
        `Bee Code: ${dto?.path ?? "文件"} 已被修改，提案未应用。请让 agent 重新生成。`,
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

    const apiKey = await vscode.window.showInputBox({
      title: "Bee Code · 3/3 API Key",
      prompt: "仅存入 VS Code SecretStorage（OS 凭据库），不会写入 settings.json / 日志 / git",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 8 ? "看起来不像有效密钥" : undefined),
    });
    if (apiKey === undefined) return;

    await this.context.secrets.store(this.config.apiKeyId, apiKey.trim());
    const cfg = vscode.workspace.getConfiguration("beeCode");
    await cfg.update("model.baseUrl", baseUrl.trim(), vscode.ConfigurationTarget.Global);
    await cfg.update("model.model", model.trim(), vscode.ConfigurationTarget.Global);

    const read = readConfig();
    this.config = read.config;
    for (const problem of read.problems) this.log.warn(`配置有问题：${problem}`);
    this.log.info(`模型已配置：${this.config.model.model} @ ${this.config.model.baseUrl}（key 已入库）`);
    void vscode.window.showInformationMessage("Bee Code: 模型配置完成。");

    // 配置变更会触发 restartCore()，这里不重复调
    if (this.core) {
      await this.core
        .modelReload({ modelConfig: this.config.model, apiKey: apiKey.trim() })
        .catch(() => undefined);
    }
  }

  private async restoreCheckpoint(): Promise<void> {
    // 从 git 历史读：重载窗口后依然能回滚到之前的检查点
    const records = await this.checkpoint.list();
    const items = records.map((record) => ({
      label: record.id.slice(0, 8),
      description: new Date(record.createdAt).toLocaleString(),
      detail: record.label,
      id: record.id,
    }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage("Bee Code: 还没有检查点（写入前会自动创建）。");
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: "Bee Code · 恢复到检查点",
      placeHolder: "选择要回滚到的快照",
    });
    if (!picked) return;

    const confirm = await vscode.window.showWarningMessage(
      "恢复会用该检查点覆盖当前工作区文件（包括你自己的未提交修改）。继续？",
      { modal: true },
      "恢复",
    );
    if (confirm !== "恢复") return;

    const result = await this.checkpoint.restore({ id: picked.id });
    void vscode.window.showInformationMessage(
      `Bee Code: 已恢复 ${result.restored.length} 个文件。`,
    );
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
    const name = path.basename(uri.fsPath);

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
        defaultUri: vscode.Uri.file(path.join(os.homedir(), name)),
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
        if (tool.status === "start") {
          this.turn = "tool";
          this.turnDetail = tool.name;
          void this.sessions.updateStatus(this.sessionId, "thinking");
        }
        const p = params as UiToolParams;
        this.panel.setHint(`${p.status === "start" ? "运行" : p.status === "end" ? "完成" : "失败"}：${p.name}`);
        return;
      }
      case "ui.usage": {
        const p = params as UiUsageParams;
        const cost = typeof p.costUsd === "number" ? ` · $${p.costUsd.toFixed(4)}` : "";
        this.usage = `${p.inputTokens ?? 0}→${p.outputTokens ?? 0} tok${cost}`;
        this.updateStatus();
        return;
      }
      case "proposal.changed": {
        this.applyProposalChange(params as ProposalChangedParams);
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
    const confirm = createConfirmAdapter(this.context, this.log);

    // 泛型 register：方法名与参数/返回类型强绑定，写错编译期就报
    this.server.register("fs.read", (params, ctx) => fs.read(params, ctx));
    this.server.register("fs.list", (params, ctx) => fs.list(params, ctx));
    this.server.register("search.grep", (params, ctx) => search.grep(params, ctx));
    this.server.register("symbols.outline", (params, ctx) => symbols.outline(params, ctx));
    this.server.register("symbols.search", (params, ctx) => symbols.search(params, ctx));
    this.server.register("symbols.references", (params, ctx) => symbols.references(params, ctx));
    this.server.register("diagnostics.get", (params, ctx) => diagnostics.get(params, ctx));
    this.server.register("edit.apply", (params, ctx) => this.edit.apply(params, ctx));
    this.server.register("checkpoint.create", (params) => this.checkpoint.create(params));
    this.server.register("checkpoint.restore", (params) => this.checkpoint.restore(params));
    this.server.register("diff.open", (params) => this.diff.open(params));
    this.server.register("secrets.get", (params) => secrets.get(params));
    this.server.register("confirm.ask", (params, ctx) => confirm.ask(params, ctx));

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
    return `内核模式：${this.config.coreMode}`;
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
  };
}
