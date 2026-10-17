import * as vscode from "vscode";
import type { CoreApi, CoreExitHandler, CoreNotificationHandler } from "../coreApi";
import type { Logger } from "../log";
import type {
  ChatSendParams,
  InitializeParams,
  InitializeResult,
  ModelReloadParams,
  ReviewAllParams,
  ReviewTargetParams,
} from "../protocol";
import { PROTOCOL_VERSION } from "../protocol";

/**
 * 假内核（dev/mock）：只用来调壳，不实现任何 agent 逻辑。
 *
 * 为什么值得存在：壳的问题（面板、流式、取消、pending 渲染、RPC 分帧）
 * 不应该被 Python 侧的问题挡住。配 `beeCode.core.mode = "mock"` 即可。
 */
export class MockCore implements CoreApi {
  readonly mode = "mock" as const;
  readonly alive = true;

  private readonly notificationHandlers = new Set<CoreNotificationHandler>();
  private readonly exitHandlers = new Set<CoreExitHandler>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private cancelled = false;

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

    this.notify("pending.changed", {
      added: [
        {
          id: `mock_${Date.now()}`,
          path: "src/example.ts",
          symbolPath: "example()",
          status: "pending",
          additions: 12,
          deletions: 3,
          risk: "low",
        },
      ],
    });
    this.notify("ui.usage", { sessionId: params.sessionId, inputTokens: 1234, outputTokens: 256 });
  }

  async reviewKeep(params: ReviewTargetParams): Promise<void> {
    this.logger.info(`[mock] keep ${params.pendingIds.join(",")}`);
    this.notify("pending.changed", { removed: params.pendingIds });
  }

  async reviewUndo(params: ReviewTargetParams): Promise<void> {
    this.logger.info(`[mock] undo ${params.pendingIds.join(",")}`);
    this.notify("pending.changed", { removed: params.pendingIds });
  }

  async reviewKeepAll(_params: ReviewAllParams): Promise<void> {
    this.logger.info("[mock] keepAll");
    this.notify("pending.changed", { removed: ["*"] });
  }

  async reviewUndoAll(_params: ReviewAllParams): Promise<void> {
    this.logger.info("[mock] undoAll");
    this.notify("pending.changed", { removed: ["*"] });
  }

  async abort(_sessionId: string): Promise<void> {
    this.cancelled = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async modelReload(_params: ModelReloadParams): Promise<void> {
    this.logger.info("[mock] model.reload");
  }

  async shutdown(): Promise<void> {
    await this.abort("");
  }

  onNotification(handler: CoreNotificationHandler): vscode.Disposable {
    this.notificationHandlers.add(handler);
    return { dispose: () => this.notificationHandlers.delete(handler) };
  }

  onExit(handler: CoreExitHandler): vscode.Disposable {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  dispose(): void {
    void this.shutdown();
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
