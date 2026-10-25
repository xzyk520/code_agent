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
 * Fake kernel (dev/mock): only for exercising the shell; implements no agent logic at all.
 *
 * Why it earns its place: shell problems (panel, streaming, cancellation, proposal rendering, RPC
 * framing) should not be blocked by problems on the Python side. Set `beeCode.core.mode = "mock"` to use it.
 *
 * It deliberately covers three critical shell paths:
 *   - streaming output (`ui.delta` chunks)
 *   - the tool phase (`ui.tool` start/end) -- to verify the recovery branch for "reload while stopped at a tool call"
 *   - pending proposals (`proposal.changed` + `proposal.read/decide`)
 * plus one manual path: `simulateCrash()` fires `exitHandlers` to verify kernel-crash handling.
 */
export class MockCore implements CoreApi {
  readonly kind = "mock" as const;

  get alive(): boolean {
    return !this.disposed;
  }

  private readonly notificationHandlers = new Set<CoreNotificationHandler>();
  private readonly exitHandlers = new Set<CoreExitHandler>();
  /** Timer -> its resolve: on cancellation the waiters must be woken up, otherwise the awaits never return */
  private readonly timers = new Map<NodeJS.Timeout, () => void>();
  private cancelled = false;
  /** Fake "virtual file" contents: proposal.read reads from here */
  private readonly proposals = new Map<string, string>();
  private disposed = false;

  /**
   * @param proposalPath supplies "which real file the proposal points at"; if omitted it falls back to
   *   `src/example.ts` (which may not exist, so "View" would show an empty diff -- in real use the
   *   extension injects a file that exists)
   */
  constructor(
    private readonly logger: Logger,
    private readonly proposalPath?: () => Promise<string | undefined>,
  ) {}

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    this.logger.info(`[mock] initialize: ${params.workspaceRoots.length} roots, model=${params.modelConfig.model || "<empty>"}`);
    return { protocolVersion: PROTOCOL_VERSION, coreVersion: "mock-0.0.1" };
  }

  async chatSend(params: ChatSendParams): Promise<void> {
    this.cancelled = false;

    const reply = [
      `[mock core] Received question with mode=${params.mode}:`,
      params.text,
      "",
      "This is a fake response to verify: streaming panel rendering / stop button / tool phase / pending proposals.",
      "Set beeCode.core.mode back to python to use the real core.",
    ].join("\n");

    for (const chunk of chunkText(reply, CHUNK_SIZE)) {
      if (this.cancelled) return this.finishCancelled(params.sessionId);
      await this.sleep(CHUNK_DELAY_MS);
      if (this.cancelled) return this.finishCancelled(params.sessionId);
      this.notify("ui.delta", { sessionId: params.sessionId, text: chunk });
    }

    // Tool phase: lets the "reload while stopped at a tool call" recovery branch be verified for real
    this.notify("ui.tool", { sessionId: params.sessionId, name: "read_file", status: "start" });
    await this.sleep(CHUNK_DELAY_MS * 4);
    if (this.cancelled) return this.finishCancelled(params.sessionId);
    this.notify("ui.tool", { sessionId: params.sessionId, name: "read_file", status: "end", summary: "mock read complete" });

    // Fabricate a proposal: the virtual file content is stored here and pulled by proposal.read when the user clicks "View"
    const id = `mock_${Date.now()}`;
    this.proposals.set(
      id,
      [
        "// [mock] This is the proposal content (the left side is the real file on your disk)",
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
          summary: "Mock example change",
        },
      ],
    });
    this.notify("ui.usage", { sessionId: params.sessionId, inputTokens: 1234, outputTokens: 256 });
  }

  async contextSummarize(_params: ContextSummarizeParams): Promise<ContextSummarizeResult> {
    // The mock has no model: return an empty summary and the shell falls back to the mechanical summary
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
    // Wake everything waiting on sleep immediately -- otherwise stopping waits one full chunk cycle
    this.clearTimers();
  }

  async modelReload(_params: ModelReloadParams): Promise<void> {
    this.logger.info("[mock] model.reload");
  }

  /** Idempotent: just clear all in-flight timers; there is no process to wait for */
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

  /** Synchronous release: no waiting, never throws, idempotent */
  dispose(): void {
    this.cancelled = true;
    this.disposed = true;
    this.clearTimers();
    this.notificationHandlers.clear();
    this.exitHandlers.clear();
  }

  /**
   * Simulate a kernel crash: fires `exitHandlers` so the shell runs through the "kernel died" handling path.
   * Only for dev commands (`beeCode.dev.crashMock`).
   */
  simulateCrash(reason = "mock simulated crash"): void {
    this.logger.warn(`[mock] Simulated crash: ${reason}`);
    this.cancelled = true;
    this.disposed = true;
    this.clearTimers();
    for (const handler of this.exitHandlers) {
      try {
        handler(1, reason);
      } catch (err) {
        this.logger.warn(`[mock] exit handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ───────────────────────── internals ─────────────────────────

  private async resolveProposalPath(): Promise<string> {
    if (this.proposalPath) {
      try {
        const path = await this.proposalPath();
        if (path) return path;
      } catch {
        /* Ignore: fall back to the default */
      }
    }
    return "src/example.ts";
  }

  private finishCancelled(sessionId: string): void {
    this.notify("ui.delta", { sessionId, text: "\n\n(stopped)" });
  }

  /** Cancellable sleep: registers a timer and clears it plus resolves when cancelled */
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
        // One handler throwing should not stop other handlers from receiving the notification
        this.logger.warn(`[mock] handler for notification ${method} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** Split by **code point**: splitting by UTF-16 would cut emoji / rare characters into lone surrogates, which the panel renders as garbage */
function chunkText(text: string, size: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}
