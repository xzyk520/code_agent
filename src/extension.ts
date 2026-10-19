import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createConfirmAdapter, createSecretAdapter } from "./adapters/interactionAdapter";
import { createDiagnosticsAdapter } from "./adapters/diagnosticsAdapter";
import { CheckpointAdapter } from "./adapters/checkpointAdapter";
import { DiffAdapter } from "./adapters/diffAdapter";
import { createEditAdapter } from "./adapters/editAdapter";
import { createFsAdapter } from "./adapters/fsAdapter";
import { createSearchAdapter } from "./adapters/searchAdapter";
import { createSymbolsAdapter } from "./adapters/symbolsAdapter";
import { registerCommands } from "./commands/register";
import { defaultInstruction, describeConfig, isWorkspaceEmpty, newSessionId, readConfig, workspaceRoots, type ShellConfig } from "./config";
import { loadContract, verifyRegistration } from "./contract";
import type { CoreApi } from "./coreApi";
import { CoreNotFoundError, describeLaunch, locateCore } from "./coreLocator";
import { exportDiagnostics as writeDiagnostics } from "./diagnostics";
import { MockCore } from "./dev/mockCore";
import { Logger } from "./log";
import { ChatViewProvider, type AttachedContext } from "./panel/chatViewProvider";
import { toWorkspaceRelative } from "./paths";
import type {
  Attachment,
  ChatSendParams,
  InitializeParams,
  LogParams,
  Mode,
  PendingItemDto,
  PendingChangedParams,
  UiDeltaParams,
  UiToolParams,
  UiUsageParams,
} from "./protocol";
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
  private readonly sessionId = newSessionId();
  private readonly pending = new Map<string, PendingItemDto>();
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

    this.panel = new ChatViewProvider(context.extensionUri, {
      onSend: (text, mode, attachments) => void this.send(text, mode, attachments),
      onKeep: (ids) => void this.review("keep", ids),
      onUndo: (ids) => void this.review("undo", ids),
      onKeepAll: () => void this.reviewAll("keep"),
      onUndoAll: () => void this.reviewAll("undo"),
      onAbort: () => void this.abort(),
    });

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = "beeCode.chat.ask";
    this.status.show();

    this.registerAdapters();
  }

  async start(): Promise<void> {
    this.log.info(`激活：${describeConfig(this.config)}`);

    // 所有"可释放资源"只有一个所有者：context.subscriptions。
    // VS Code 会在 deactivate() 返回后统一 dispose，避免我们与它双重释放。
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, this.panel, {
        webviewOptions: { retainContextWhenHidden: false },
      }),
    );

    registerCommands(this.context, {
      panel: this.panel,
      log: this.log,
      configureModel: () => this.configureModel(),
      restartCore: () => this.restartCore(),
      restoreCheckpoint: () => this.restoreCheckpoint(),
      keepAll: () => this.reviewAll("keep"),
      undoAll: () => this.reviewAll("undo"),
      pickFiles: () => this.pickFiles(),
      exportDiagnostics: () => this.exportDiagnostics(),
    });

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

    this.context.subscriptions.push(this.status, this.log, this.diff, this.checkpoint);
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

    const core = this.core;
    this.core = undefined;
    if (core) {
      await core.shutdown().catch(() => undefined);
      core.dispose();
    }
    this.log.info("已停用");
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

    this.panel.addMessage({ id: `u_${Date.now()}`, role: "user", text: trimmed || defaultInstruction(mode) });
    this.setBusy(true);

    try {
      const core = await this.ensureCore();
      const params: ChatSendParams = {
        sessionId: this.sessionId,
        mode,
        text: trimmed,
        attachments: attachments.map(toAttachment),
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
      this.panel.pushState();
    }
  }

  private async review(action: "keep" | "undo", ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const core = await this.ensureCore();
      if (action === "keep") await core.reviewKeep({ pendingIds: ids });
      else await core.reviewUndo({ pendingIds: ids });

      for (const id of ids) {
        const item = this.pending.get(id);
        if (item) item.status = action === "keep" ? "kept" : "undone";
        this.pending.delete(id);
      }
      this.refreshPending();
    } catch (err) {
      this.log.error(`${action} 失败`, err instanceof Error ? err.message : String(err));
    }
  }

  private async reviewAll(action: "keep" | "undo"): Promise<void> {
    try {
      const core = await this.ensureCore();
      if (action === "keep") await core.reviewKeepAll({ sessionId: this.sessionId });
      else await core.reviewUndoAll({ sessionId: this.sessionId });
      this.pending.clear();
      this.refreshPending();
    } catch (err) {
      this.log.error(`${action}All 失败`, err instanceof Error ? err.message : String(err));
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
    const items = this.checkpoint.list().map((record) => ({
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

    const result = await this.checkpoint.restore({ id: picked.id, scope: "files" });
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
        this.panel.appendDelta(p.text);
        return;
      }
      case "ui.tool": {
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
      case "pending.changed": {
        this.applyPendingChange(params as PendingChangedParams);
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

  private applyPendingChange(change: PendingChangedParams): void {
    if (change.removed?.includes("*")) {
      this.pending.clear();
    } else {
      for (const id of change.removed ?? []) this.pending.delete(id);
    }
    for (const item of change.added ?? []) this.pending.set(item.id, item);
    for (const item of change.updated ?? []) this.pending.set(item.id, item);
    this.refreshPending();
  }

  private refreshPending(): void {
    const items = [...this.pending.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.panel.setPending(
      items.map((item) => ({
        id: item.id,
        path: item.path,
        symbolPath: item.symbolPath,
        additions: item.additions,
        deletions: item.deletions,
        risk: item.risk,
        status: item.status,
      })),
    );
    this.updateStatus();
  }

  // ───────────────────────── 适配器注册 ─────────────────────────

  private registerAdapters(): void {
    const fs = createFsAdapter(this.log);
    const search = createSearchAdapter(this.log);
    const symbols = createSymbolsAdapter(this.log);
    const diagnostics = createDiagnosticsAdapter(this.log);
    const edit = createEditAdapter(this.log);
    const secrets = createSecretAdapter(this.context, this.log);
    const confirm = createConfirmAdapter(this.log);

    // 泛型 register：方法名与参数/返回类型强绑定，写错编译期就报
    this.server.register("fs.read", (params, ctx) => fs.read(params, ctx));
    this.server.register("fs.list", (params, ctx) => fs.list(params, ctx));
    this.server.register("search.grep", (params, ctx) => search.grep(params, ctx));
    this.server.register("symbols.outline", (params, ctx) => symbols.outline(params, ctx));
    this.server.register("diagnostics.get", (params, ctx) => diagnostics.get(params, ctx));
    this.server.register("edit.apply", (params, ctx) => edit.apply(params, ctx));
    this.server.register("checkpoint.create", (params) => this.checkpoint.create(params));
    this.server.register("checkpoint.restore", (params) => this.checkpoint.restore(params));
    this.server.register("diff.open", (params) => this.diff.open(params));
    this.server.register("secrets.get", (params) => secrets.get(params));
    this.server.register("confirm.ask", (params) => confirm.ask(params));

    // 用 info 而不是 debug：log channel 默认级别是 info，debug 会被过滤掉
    this.log.info(`已注册 RPC 方法: ${this.server.listed().join(", ")}`);

    this.verifyProtocolContract();
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
    const pendingCount = this.pending.size;
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
