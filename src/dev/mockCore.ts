import type * as vscode from "vscode";
import type { CoreApi, CoreExitHandler, CoreNotificationHandler } from "../coreApi";
import type { Logger } from "../log";
import type {
  ChatSendParams,
  InitializeParams,
  InitializeResult,
  ModelReloadParams,
  ProposalDecideParams,
  ContextSummarizeParams,
  ContextSummarizeResult,
  ProposalReadParams,
  ProposalReadResult,
} from "../protocol";
import { PROTOCOL_VERSION } from "../protocol";

const CHUNK_SIZE = 24;
const CHUNK_DELAY_MS = 40;

/**
 * 假内核（dev/mock）：只用来调壳，不实现任何 agent 逻辑。
 *
 * 为什么值得存在：壳的问题（面板、流式、取消、提案渲染、RPC 分帧）
 * 不应该被 Python 侧的问题挡住。配 `beeCode.core.mode = "mock"` 即可。
 *
 * 它刻意覆盖了壳的三条关键路径：
 *   - 流式输出（`ui.delta` 分片）
 *   - 工具阶段（`ui.tool` start/end）—— 用于验证「重载时停在工具调用」的恢复分支
 *   - 待审提案（`proposal.changed` + `proposal.read/decide`）
 * 以及一条手工路径：`simulateCrash()` 触发 `exitHandlers`，验证内核崩溃的处理。
 */
export class MockCore implements CoreApi {
  readonly kind = "mock" as const;

  get alive(): boolean {
    return !this.disposed;
  }

  private readonly notificationHandlers = new Set<CoreNotificationHandler>();
  private readonly exitHandlers = new Set<CoreExitHandler>();
  /** 定时器 → 它的 resolve：取消时要主动唤醒等待者，否则 await 永远不返回 */
  private readonly timers = new Map<NodeJS.Timeout, () => void>();
  private cancelled = false;
  /** 假的"虚拟文件"内容：proposal.read 从这里取 */
  private readonly proposals = new Map<string, string>();
  private disposed = false;

  /**
   * @param proposalPath 提供「提案指向哪个真实文件」；没提供就退回 `src/example.ts`（可能就是假的，
   *   点「查看」会看到空 diff —— 所以真实使用时由 extension 注入一个存在的文件）
   */
  constructor(
    private readonly logger: Logger,
    private readonly proposalPath?: () => Promise<string | undefined>,
  ) {}

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    this.logger.info(`[mock] initialize：${params.workspaceRoots.length} 个根，model=${params.modelConfig.model || "<空>"}`);
    return { protocolVersion: PROTOCOL_VERSION, coreVersion: "mock-0.0.1" };
  }

  async chatSend(params: ChatSendParams): Promise<void> {
    this.cancelled = false;

    const reply = [
      `[mock 内核] 收到 mode=${params.mode} 的问题：`,
      params.text,
      "",
      "这是个假响应，用来验证：面板流式渲染 / 停止按钮 / 工具阶段 / 待审提案。",
      "把 beeCode.core.mode 改回 python 就会走真实内核。",
    ].join("\n");

    for (const chunk of chunkText(reply, CHUNK_SIZE)) {
      if (this.cancelled) return this.finishCancelled(params.sessionId);
      await this.sleep(CHUNK_DELAY_MS);
      if (this.cancelled) return this.finishCancelled(params.sessionId);
      this.notify("ui.delta", { sessionId: params.sessionId, text: chunk });
    }

    // 工具阶段：让「重载时停在工具调用」这条恢复分支可以被真实验证
    this.notify("ui.tool", { sessionId: params.sessionId, name: "read_file", status: "start" });
    await this.sleep(CHUNK_DELAY_MS * 4);
    if (this.cancelled) return this.finishCancelled(params.sessionId);
    this.notify("ui.tool", { sessionId: params.sessionId, name: "read_file", status: "end", summary: "mock 读取完成" });

    // 造一个提案：虚拟文件内容存在这里，用户点「查看」时由 proposal.read 拉走
    const id = `mock_${Date.now()}`;
    this.proposals.set(
      id,
      [
        "// [mock] 这是提案内容（左侧是你磁盘上的真实文件）",
        "export function example(): number {",
        "  return 42;",
        "}",
        "",
      ].join("\n"),
    );
    const path = await this.resolveProposalPath();
    this.notify("proposal.changed", {
      added: [
        {
          id,
          path,
          status: "pending",
          additions: 4,
          deletions: 1,
          summary: "mock 的示例改动",
        },
      ],
    });
    this.notify("ui.usage", { sessionId: params.sessionId, inputTokens: 1234, outputTokens: 256 });
  }

  async contextSummarize(_params: ContextSummarizeParams): Promise<ContextSummarizeResult> {
    // mock 没有模型：返回空摘要，壳会自动退回机械摘要
    return { summary: "", pairs: [] };
  }

  async proposalRead(params: ProposalReadParams): Promise<ProposalReadResult> {
    return { text: this.proposals.get(params.id) ?? "" };
  }

  async proposalDecide(params: ProposalDecideParams): Promise<void> {
    this.logger.info(`[mock] proposal ${params.id} → ${params.decision}`);
    this.proposals.delete(params.id);
    this.notify("proposal.changed", { removed: [params.id] });
  }

  async abort(_sessionId: string): Promise<void> {
    this.cancelled = true;
    // 立刻唤醒所有在等 sleep 的地方 —— 否则要等一个 chunk 周期才停
    this.clearTimers();
  }

  async modelReload(_params: ModelReloadParams): Promise<void> {
    this.logger.info("[mock] model.reload");
  }

  /** 幂等：清掉所有在飞的定时器即可，没有进程需要等 */
  async shutdown(): Promise<void> {
    this.cancelled = true;
    this.disposed = true;
    this.clearTimers();
  }

  onNotification(handler: CoreNotificationHandler): vscode.Disposable {
    this.notificationHandlers.add(handler);
    return { dispose: () => this.notificationHandlers.delete(handler) };
  }

  onExit(handler: CoreExitHandler): vscode.Disposable {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  /** 同步释放：不等待、不抛错、幂等 */
  dispose(): void {
    this.cancelled = true;
    this.disposed = true;
    this.clearTimers();
    this.notificationHandlers.clear();
    this.exitHandlers.clear();
  }

  /**
   * 模拟内核崩溃：触发 `exitHandlers`，让壳走一遍「内核挂了」的处理路径。
   * 只给 dev 命令用（`beeCode.dev.crashMock`）。
   */
  simulateCrash(reason = "mock 模拟崩溃"): void {
    this.logger.warn(`[mock] 模拟崩溃：${reason}`);
    this.cancelled = true;
    this.disposed = true;
    this.clearTimers();
    for (const handler of this.exitHandlers) {
      try {
        handler(1, reason);
      } catch (err) {
        this.logger.warn(`[mock] exit handler 抛错: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async resolveProposalPath(): Promise<string> {
    if (this.proposalPath) {
      try {
        const path = await this.proposalPath();
        if (path) return path;
      } catch {
        /* 忽略：退回默认值 */
      }
    }
    return "src/example.ts";
  }

  private finishCancelled(sessionId: string): void {
    this.notify("ui.delta", { sessionId, text: "\n\n（已停止）" });
  }

  /** 可取消的 sleep：登记定时器，取消时同时 clearTimeout 并 resolve */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.set(timer, resolve);
    });
  }

  private clearTimers(): void {
    for (const [timer, resolve] of this.timers) {
      clearTimeout(timer);
      resolve();
    }
    this.timers.clear();
  }

  private notify(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(method, params);
      } catch (err) {
        // 一个 handler 抛错不该影响其他 handler 收通知
        this.logger.warn(`[mock] 通知 ${method} 的 handler 抛错: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** 按 **code point** 切分：按 UTF-16 切会把 emoji / 生僻字劈成孤立代理，面板渲染成乱码 */
function chunkText(text: string, size: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}
