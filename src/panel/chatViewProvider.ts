import * as vscode from "vscode";
import type { ProposalDto } from "../protocol";

/** 面板要显示的一条消息（shell 侧的视图模型，与协议无关） */
export interface ChatMessageView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

export interface AttachedContext {
  path: string;
  startLine?: number;
  endLine?: number;
  text?: string;
  kind: "selection" | "file" | "diagnostic";
}

export interface PanelHandlers {
  onSend(text: string, mode: "chat" | "builder" | "debugger", attachments: AttachedContext[]): void;
  onAccept(ids: string[]): void;
  onReject(ids: string[]): void;
  onAcceptAll(): void;
  onRejectAll(): void;
  onShowProposal(id: string): void;
  onAbort(): void;
}

export interface PanelState {
  mode: "chat" | "builder" | "debugger";
  busy: boolean;
  proposals: ProposalDto[];
  messages: ChatMessageView[];
  attachments: AttachedContext[];
  hint?: string;
}

/**
 * 侧边栏面板宿主（WebviewView）。
 *
 * 职责边界很硬：只做「渲染 + 把用户动作转成回调」。
 * 不拼提示词、不解析模型输出、不保存会话状态机 —— 那些都在内核里。
 *
 * 安全：CSP nonce、localResourceRoots 限定到 media/、消息 type 白名单、
 * **不信任**前端传来的路径（面板只能传 pending id）。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "beeCode.chatView";

  private view: vscode.WebviewView | undefined;
  private state: PanelState = {
    mode: "chat",
    busy: false,
    proposals: [],
    messages: [],
    attachments: [],
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    view.webview.html = buildHtml(view.webview, mediaRoot);
    view.webview.onDidReceiveMessage((raw) => this.onMessage(raw));

    view.onDidChangeVisibility(() => {
      if (view.visible) this.pushState();
    });
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  setBusy(busy: boolean): void {
    this.state.busy = busy;
    this.pushState();
  }

  setMode(mode: PanelState["mode"]): void {
    this.state.mode = mode;
    this.pushState();
  }

  setHint(hint: string | undefined): void {
    this.state.hint = hint;
    this.pushState();
  }

  addMessage(message: ChatMessageView): void {
    this.state.messages.push(message);
    this.post({ type: "message", message });
  }

  /** 流式增量：高频，所以只发增量，不重发整份状态 */
  appendDelta(text: string): void {
    this.post({ type: "delta", text });
  }

  setProposals(items: ProposalDto[]): void {
    this.state.proposals = items;
    this.post({ type: "proposals", items });
  }

  addAttachment(attachment: AttachedContext): void {
    this.state.attachments.push(attachment);
    this.post({ type: "attachments", items: this.state.attachments });
  }

  clearAttachments(): void {
    this.state.attachments = [];
    this.post({ type: "attachments", items: [] });
  }

  pushState(): void {
    this.post({ type: "state", state: this.state });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** 前端消息必须过白名单；只接受 id / 纯文本，不接受路径 */
  private onMessage(raw: unknown): void {
    const msg = raw as { type?: unknown; text?: unknown; ids?: unknown; mode?: unknown; id?: unknown };
    const type = typeof msg.type === "string" ? msg.type : "";

    switch (type) {
      case "ready":
        this.pushState();
        return;
      case "send": {
        const text = typeof msg.text === "string" ? msg.text.slice(0, 20_000) : "";
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
      case "mode":
        if (msg.mode === "builder" || msg.mode === "debugger" || msg.mode === "chat") {
          this.state.mode = msg.mode;
          this.pushState();
        }
        return;
      default:
        // 未知消息一律忽略，不报错、不回显
        return;
    }
  }
}

function toIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string").slice(0, 500);
}

function buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const nonce = makeNonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "panel.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "panel.css"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<title>Bee Code</title>
</head>
<body>
  <header class="bar">
    <div class="modes" role="tablist">
      <button data-mode="chat" class="mode">Chat</button>
      <button data-mode="builder" class="mode">Builder</button>
      <button data-mode="debugger" class="mode">Debugger</button>
    </div>
    <button id="stop" class="stop" title="停止">■</button>
  </header>

  <section id="attachments" class="attachments"></section>
  <section id="messages" class="messages"></section>
  <section id="pending" class="pending hidden">
    <div class="pending-head">
      <span id="pending-title">待审提案</span>
      <span class="pending-actions">
        <button id="keepAll">全部接受</button>
        <button id="undoAll">全部拒绝</button>
      </span>
    </div>
    <ul id="pending-list"></ul>
  </section>

  <footer class="composer">
    <textarea id="input" placeholder="描述你的需求…（Ctrl+Enter 发送）" rows="3"></textarea>
    <div class="composer-row">
      <span id="hint" class="hint"></span>
      <button id="send">发送</button>
    </div>
  </footer>

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
