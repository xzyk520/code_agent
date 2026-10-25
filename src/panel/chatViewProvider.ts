import * as vscode from "vscode";
import type { DiagramDto, Mode, PlanStep, ProposalDto, TraceStepDto, UiDiagramParams, UiPlanParams, UiReadParams, UiRetryParams, UiSubagentParams } from "../protocol";
import { tr, type Locale } from "../i18n";

/** A message to display in the panel (shell-side view model, independent of the protocol) */
export interface ChatMessageView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** Reasoning content kept for review (not part of the model context); array = split per model call */
  reasoning?: string | Array<{ round: number; text: string }>;
  /** Diagrams attached to the assistant answer */
  diagrams?: DiagramDto[];
}

export interface AttachedContext {
  path: string;
  /** Unsaved documents (untitled:) have no real path, so the core must not pass it to fs.read */
  untitled?: boolean;
  startLine?: number;
  endLine?: number;
  text?: string;
  kind: "selection" | "file" | "diagnostic" | "focus";
  /** Symbol name for a focus attachment */
  symbol?: string;
}

/**
 * Validates the "open a read file" request sent by the webview.
 *
 * Webview messages are untrusted: only workspace-relative paths are accepted; absolute paths and `..` are rejected;
 * line numbers must be finite numbers (truncated to integers); invalid input always returns undefined.
 */
export function parseOpenRead(raw: unknown): { path: string; startLine?: number; endLine?: number } | undefined {
  const msg = (raw ?? {}) as { path?: unknown; startLine?: unknown; endLine?: unknown };
  const path = typeof msg.path === "string" ? msg.path : "";
  if (!path || path.length > 500) return undefined;
  const normalized = path.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return undefined;

  const toLine = (value: unknown): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const line = Math.trunc(value);
    return line > 0 && line < 10_000_000 ? line : undefined;
  };
  const startLine = toLine(msg.startLine);
  const endLine = toLine(msg.endLine);
  return { path, ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) };
}

export interface PanelHandlers {
  onSend(text: string, mode: Mode, attachments: AttachedContext[]): void;
  onAccept(ids: string[]): void;
  onReject(ids: string[]): void;
  onAcceptAll(): void;
  onRejectAll(): void;
  onShowProposal(id: string): void;
  onAbort(): void;
  /** Clicking a "read file" chip: open the file and jump to the line range */
  onOpenRead(path: string, startLine?: number, endLine?: number): void;
  /** Undo the file changes made by a specific command */
  onRestoreCommand(id: string): void;
  /** Retry the request that failed in the previous turn */
  onRetryTurn(): void;
  /** Open the session switcher from the panel header */
  onSessions(): void;
  /** Open the model configuration menu from the panel header */
  onModelSettings(): void;
  /** Explicit notice to the user when an attachment is truncated or ignored (toast + panel system message) */
  onAttachmentNotice(message: string): void;
}

export interface TurnView {
  userMessageId?: string;
  status: "ok" | "error";
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs?: number;
  modelWaitMs?: number;
  toolMs?: number;
  trace?: TraceStepDto[];
}

export interface PanelState {
  locale: Locale;
  fontSize: number;
  mode: Mode;
  busy: boolean;
  proposals: ProposalDto[];
  messages: ChatMessageView[];
  attachments: AttachedContext[];
  plan?: PlanStep[];
  turns?: TurnView[];
  commandCheckpoints?: Array<{ id: string; files: string[]; command: string }>;
  retryAvailable?: boolean;
  hint?: string;
}

/**
 * Sidebar panel host (WebviewView).
 *
 * The responsibility boundary is strict: only render and turn user actions into callbacks.
 * No prompt building, model-output parsing, or session state machine — those live in the core.
 *
 * Security: CSP nonce, localResourceRoots limited to media/, message type allowlist,
 * and paths from the front end are **never trusted** (the panel may only pass proposal ids).
 */
/** Maximum number of messages the panel keeps (oldest are dropped beyond this to keep the DOM from growing without bound) */
const MAX_MESSAGES = 300;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "beeCode.chatView";

  private view: vscode.WebviewView | undefined;
  /** View-scoped listeners: release the old ones before rebuilding the view */
  private viewDisposables: vscode.Disposable[] = [];
  private state: PanelState = {
    locale: "en",
    fontSize: 14,
    mode: "chat",
    busy: false,
    proposals: [],
    messages: [],
    attachments: [],
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers,
    private readonly attachmentLimits: { maxCount: number; maxTotalChars: number; maxCharsPerItem: number },
    locale: Locale = "en",
    fontSize = 14,
  ) {
    this.state.locale = locale;
    this.state.fontSize = fontSize;
  }

  /** Change the chat panel base font size without rebuilding the view. */
  setFontSize(fontSize: number): void {
    if (this.state.fontSize === fontSize) return;
    this.state.fontSize = fontSize;
    this.post({ type: "fontSize", fontSize });
  }

  /** Switch the user-visible language; model prompts are unaffected */
  setLocale(locale: Locale): void {
    if (this.state.locale === locale) return;
    this.state.locale = locale;
    this.post({ type: "locale", locale });
    this.pushState();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const disposable of this.viewDisposables.splice(0)) disposable.dispose();
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    view.webview.html = buildHtml(view.webview, mediaRoot, this.state.locale, this.state.fontSize);
    this.viewDisposables.push(view.webview.onDidReceiveMessage((raw) => this.onMessage(raw)));
    this.viewDisposables.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) this.pushState();
      }),
    );
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  /** Restore the chat history after a reload (does not change the state machine, only refills the view) */
  /** Set the per-turn trace (used by the collapsible card under each user message) */
  setTurns(turns: TurnView[]): void {
    this.state.turns = turns;
  }

  restore(messages: ChatMessageView[], mode?: PanelState["mode"]): void {
    this.state.messages = messages.slice(-MAX_MESSAGES);
    this.state.commandCheckpoints = [];
    this.state.retryAvailable = false;
    if (mode) this.state.mode = mode;
    this.pushState();   // Full snapshot: only needed on reload or session switch
  }

  /** Current full message list (used for session persistence) */
  getMessages(): ChatMessageView[] {
    return [...this.state.messages];
  }

  getMode(): Mode {
    return this.state.mode;
  }

  setBusy(busy: boolean): void {
    this.state.busy = busy;
    this.pushStatus();
  }

  setMode(mode: PanelState["mode"]): void {
    this.state.mode = mode;
    this.pushStatus();
  }

  setHint(hint: string | undefined): void {
    this.state.hint = hint;
    this.pushStatus();
  }

  addMessage(message: ChatMessageView): void {
    this.state.messages.push(message);
    if (this.state.messages.length > MAX_MESSAGES) {
      // After trimming, the whole list must be resent, otherwise the DOM and state drift apart
      this.state.messages = this.state.messages.slice(-MAX_MESSAGES);
      this.pushState();
      return;
    }
    this.post({ type: "message", message });
  }

  /** Streaming delta: high frequency, so send only the delta instead of resending the full state */
  appendDelta(text: string): void {
    this.post({ type: "delta", text });
  }

  /** Subagent progress: the front end groups entries by id into collapsible cards */
  subagentEvent(params: UiSubagentParams): void {
    this.post({ type: "subagent", ...params });
  }


  /** Plan checklist (produced by update_plan for large tasks) */
  /** Command-level checkpoint: shows the changed files and an undo button after a command finishes */
  commandCheckpointEvent(item: { id: string; files: string[]; command: string }): void {
    const list = this.state.commandCheckpoints ?? [];
    if (!list.some((entry) => entry.id === item.id)) {
      list.push(item);
      this.state.commandCheckpoints = list;
    }
    this.post({ type: "commandCheckpoint", item });
  }

  setRetryAvailable(available: boolean): void {
    this.state.retryAvailable = available;
    this.post({ type: "retryAvailable", available });
  }

  retryEvent(params: UiRetryParams): void {
    this.post({ type: "retry", ...params });
  }

  commandCheckpointRestored(id: string, files: number): void {
    this.state.commandCheckpoints = (this.state.commandCheckpoints ?? []).filter((entry) => entry.id !== id);
    this.post({ type: "commandCheckpointRestored", id, files });
  }

  planEvent(params: UiPlanParams): void {
    this.state.plan = params.steps;
    this.post({ type: "plan", ...params });
  }

  /** The model generated a diagram (the front end lazily loads Mermaid and renders it) */
  diagramEvent(params: UiDiagramParams): void {
    this.post({ type: "diagram", diagram: params.diagram });
  }

  /** Reasoning delta (split per model call, not added to the context) */
  reasoningDelta(text: string, round = 1): void {
    this.post({ type: "reasoning", text, round });
  }

  /** A new turn starts: clear the previous turn reasoning block */
  resetReasoning(): void {
    this.post({ type: "reasoningReset" });
  }

  /** Task-level cost (tokens / elapsed time for this turn) */
  setCost(text: string): void {
    this.post({ type: "cost", text });
  }

  /** Session trace: lists each turn by intent; clicking jumps to the matching message */
  setTrajectory(items: Array<{ id: string; mode: Mode; intent: string; detail?: string }>): void {
    this.post({ type: "trajectory", items });
  }

  addTrajectoryItem(item: { id: string; mode: Mode; intent: string; detail?: string }): void {
    this.post({ type: "trajectoryItem", item });
  }

  /** Restore the plan on reload or session switch */
  setPlan(plan: PlanStep[] | undefined): void {
    this.state.plan = plan;
    if (plan && plan.length > 0) this.post({ type: "plan", steps: plan });
  }

  getPlan(): PlanStep[] | undefined {
    return this.state.plan;
  }

  /** A proposal was accepted: mark plan steps mentioning this file as done (pure UI inference) */
  planStepDone(path: string): void {
    const plan = this.state.plan;
    if (!plan || plan.length === 0) return;
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    const base = normalized.split("/").pop() ?? "";
    let changed = false;
    for (const step of plan) {
      if (step.status === "done") continue;
      const text = step.text.replace(/\\/g, "/").toLowerCase();
      if (text.includes(normalized) || (base.length > 0 && text.includes(base))) {
        step.status = "done";
        changed = true;
        break;
      }
    }
    if (changed) this.post({ type: "plan", steps: plan });
  }

  /** The agent read a file: add a file-name chip to the panel (the editor draws the range via FocusHighlighter) */
  readEvent(params: UiReadParams): void {
    this.post({ type: "reads", item: params });
  }

  setProposals(items: ProposalDto[]): void {
    this.state.proposals = items;
    this.post({ type: "proposals", items });
  }

  /** Add an attachment (with count/size limits); returns whether it succeeded and gives an explicit notice when a limit is exceeded */
  addAttachment(attachment: AttachedContext): boolean {
    const limits = this.attachmentLimits;
    if (this.state.attachments.length >= limits.maxCount) {
      this.handlers.onAttachmentNotice(
        `At most ${limits.maxCount} attachments are allowed: only the first ${limits.maxCount} were kept; the rest were ignored.`,
      );
      return false;
    }

    let text = attachment.text ?? "";
    let truncatedByItem = false;
    if (text.length > limits.maxCharsPerItem) {
      text = `${text.slice(0, limits.maxCharsPerItem)}\n... (attachment truncated)`;
      truncatedByItem = true;
    }

    const current = this.state.attachments.reduce((sum, item) => sum + (item.text?.length ?? 0), 0);
    const remaining = limits.maxTotalChars - current;
    if (remaining <= 0) {
      this.handlers.onAttachmentNotice(
        `Attachments exceed ${limits.maxTotalChars} characters in total: this item was not added (reduce the attachments or send them in batches).`,
      );
      return false;
    }
    let truncatedByTotal = false;
    if (text.length > remaining) {
      text = `${text.slice(0, remaining)}\n... (attachment truncated)`;
      truncatedByTotal = true;
    }

    if (truncatedByItem) {
      this.handlers.onAttachmentNotice(
        `A single attachment exceeds ${limits.maxCharsPerItem} characters and was truncated (use a line range to reduce its size).`,
      );
    }
    if (truncatedByTotal) {
      this.handlers.onAttachmentNotice(
        `Attachments exceed ${limits.maxTotalChars} characters in total and were truncated to the limit.`,
      );
    }

    this.state.attachments.push({ ...attachment, ...(text.length > 0 ? { text } : {}) });
    this.post({ type: "attachments", items: this.state.attachments });
    return true;
  }

  clearAttachments(): void {
    this.state.attachments = [];
    this.post({ type: "attachments", items: [] });
  }

  /** Lightweight status: carries only mode/busy/hint and leaves the message list alone (called often, so do not resend the whole history each time) */
  pushStatus(): void {
    this.post({ type: "status", mode: this.state.mode, busy: this.state.busy, hint: this.state.hint ?? "" });
  }

  /** Full snapshot: sent only when the webview just loaded, a session is restored, or messages were trimmed */
  pushState(): void {
    this.post({ type: "state", state: this.state });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** Front-end messages must pass the allowlist; only ids and plain text are accepted, never paths */
  private onMessage(raw: unknown): void {
    const msg = raw as {
      type?: unknown;
      text?: unknown;
      ids?: unknown;
      mode?: unknown;
      id?: unknown;
      path?: unknown;
      startLine?: unknown;
      endLine?: unknown;
    };
    const type = typeof msg.type === "string" ? msg.type : "";

    switch (type) {
      case "ready":
        this.pushState();
        return;
      case "send": {
        const raw = typeof msg.text === "string" ? msg.text : "";
        if (raw.length > 20_000) {
          this.setHint("Input is too long and was truncated to 20,000 characters.");
        }
        const text = raw.slice(0, 20_000);
        const mode = msg.mode === "builder" || msg.mode === "debugger" || msg.mode === "chat" ? msg.mode : this.state.mode;
        this.state.mode = mode;
        const attachments = this.state.attachments;
        this.state.attachments = [];
        this.post({ type: "attachments", items: [] });
        this.handlers.onSend(text, mode, attachments);
        return;
      }
      case "accept":
        this.handlers.onAccept(toIds(msg.ids));
        return;
      case "reject":
        this.handlers.onReject(toIds(msg.ids));
        return;
      case "acceptAll":
        this.handlers.onAcceptAll();
        return;
      case "rejectAll":
        this.handlers.onRejectAll();
        return;
      case "proposal.diff": {
        const id = typeof msg.id === "string" ? msg.id : "";
        if (id) this.handlers.onShowProposal(id);
        return;
      }
      case "stop":
        this.handlers.onAbort();
        return;
      case "retry":
        this.handlers.onRetryTurn();
        return;
      case "sessions":
        this.handlers.onSessions();
        return;
      case "modelSettings":
        this.handlers.onModelSettings();
        return;
      case "restoreCommand": {
        const id = typeof msg.id === "string" ? msg.id : "";
        if (id) this.handlers.onRestoreCommand(id);
        return;
      }
      case "openRead": {
        const target = parseOpenRead(msg);
        if (target) this.handlers.onOpenRead(target.path, target.startLine, target.endLine);
        return;
      }

      default:
        // Unknown messages are ignored: no error, no echo
        return;
    }
  }
}

function toIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string").slice(0, 500);
}

function buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, locale: Locale = "en", fontSize = 14): string {
  const nonce = makeNonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "panel.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "panel.css"));
  const mermaid = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "vendor", "mermaid.min.js"));
  const highlight = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "vendor", "highlight.min.js"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="${locale === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<style>:root { --bee-font-size: ${fontSize}px; }</style>
<title>Bee Code</title>
</head>
<body data-mermaid-uri="${mermaid}">
  <header class="bar">
    <div class="modes">
      <span id="mode-badge" class="mode-badge">Chat</span>
    </div>
    <span id="cost" class="cost"></span>
    <button id="model-settings" class="model-settings" title="${tr(locale, "Configure model", "Configure model")}">${tr(locale, "模型", "Model")}</button>
    <button id="sessions" class="sessions" title="${tr(locale, "Switch session", "Switch session")}">${tr(locale, "会话", "Sessions")}</button>
    <button id="stop" class="stop" title="${tr(locale, "Stop", "Stop")}">■</button>
  </header>

  <section id="attachments" class="attachments"></section>
  <section id="reads" class="reads" aria-label="${tr(locale, "Files recently read by the agent", "Files recently read by the agent")}"></section>
  <div id="retry-banner" class="retry-banner hidden" role="status"></div>
  <div class="conversation">
    <section id="messages" class="messages" aria-live="polite" aria-atomic="false" aria-busy="false" aria-label="${tr(locale, "Conversation", "Conversation")}"></section>
    <button id="jump-latest" class="jump-latest hidden" type="button">${tr(locale, "跳到最新", "Jump to latest")}</button>
    <aside id="trajectory" class="trajectory" aria-label="${tr(locale, "Session trace", "Session trace")}">
      <input id="trajectory-filter" class="trajectory-search" type="search" placeholder="${tr(locale, "Search trace…", "Search trace…")}" aria-label="${tr(locale, "Search trace", "Search trace")}" />
      <div id="trajectory-list" class="trajectory-list"></div>
    </aside>
  </div>
  <div id="sr-status" class="sr-only" aria-live="polite" aria-atomic="true"></div>
  <section id="proposals" class="proposals hidden">
    <div class="proposals-head">
      <span id="proposals-title">${tr(locale, "Proposals", "Proposals")}</span>
      <span class="proposals-actions">
        <button id="acceptAll">${tr(locale, "Accept all", "Accept all")}</button>
        <button id="rejectAll">${tr(locale, "Reject all", "Reject all")}</button>
      </span>
    </div>
    <ul id="proposals-list"></ul>
  </section>

  <footer class="composer">
    <textarea id="input" placeholder="${tr(locale, "Describe what you need… (Ctrl+Enter to send)", "Describe what you need… (Ctrl+Enter to send)")}" rows="3"></textarea>
    <div class="composer-row">
      <span id="hint" class="hint"></span>
      <button id="retry" class="retry hidden" type="button">${tr(locale, "Retry this turn", "Retry this turn")}</button>
      <button id="send">${tr(locale, "Send", "Send")}</button>
    </div>
  </footer>

<script nonce="${nonce}" src="${highlight}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
