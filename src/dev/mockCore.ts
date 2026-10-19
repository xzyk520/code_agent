import type * as vscode from "vscode";
import type { CoreApi, CoreExitHandler, CoreNotificationHandler } from "../coreApi";
import type { Logger } from "../log";
import type {
  ChatSendParams,
  InitializeParams,
  InitializeResult,
  ModelReloadParams,
  ProposalDecideParams,
  ProposalReadParams,
  ProposalReadResult,
} from "../protocol";
import { PROTOCOL_VERSION } from "../protocol";

/**
 * 假内核（dev/mock）：只用来调壳，不实现任何 agent 逻辑。
 *
 * 为什么值得存在：壳的问题（面板、流式、取消、pending 渲染、RPC 分帧）
 * 不应该被 Python 侧的问题挡住。配 `beeCode.core.mode = "mock"` 即可。
 */
export class MockCore implements CoreApi {
  readonly kind = "mock" as const;

  get alive(): boolean {
    return !this.disposed;
  }

  private readonly notificationHandlers = new Set<CoreNotificationHandler>();
  private readonly exitHandlers = new Set<CoreExitHandler>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private cancelled = false;
  /** 假的"虚拟文件"内容：proposal.read 从这里取 */
  private readonly proposals = new Map<string, string>();
  private disposed = false;

  constructor(private readonly logger: Logger) {}

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
      "这是个假响应，用来验证：面板流式渲染 / 停止按钮 / 待审列表。",
      "把 beeCode.core.mode 改回 python 就会走真实内核。",
    ].join("\n");

    for (const chunk of chunkText(reply, 24)) {
      if (this.cancelled) {
        this.notify("ui.delta", { sessionId: params.sessionId, text: "\n\n（已停止）" });
        return;
      }
      await delay(40);
      this.notify("ui.delta", { sessionId: params.sessionId, text: chunk });
    }

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
    this.notify("proposal.changed", {
      added: [
        {
          id,
          path: "src/example.ts",
          status: "pending",
          additions: 4,
          deletions: 1,
          summary: "mock 的示例改动",
        },
      ],
    });
    this.notify("ui.usage", { sessionId: params.sessionId, inputTokens: 1234, outputTokens: 256 });
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
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async modelReload(_params: ModelReloadParams): Promise<void> {
    this.logger.info("[mock] model.reload");
  }

  /** 幂等：清掉所有在飞的定时器即可，没有进程需要等 */
  async shutdown(): Promise<void> {
    this.cancelled = true;
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
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
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.notificationHandlers.clear();
    this.exitHandlers.clear();
  }

  private notify(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) handler(method, params);
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
