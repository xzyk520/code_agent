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
  /** 未保存文档（untitled:）没有真实路径，内核不应拿它去 fs.read */
  untitled?: boolean;
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
/** 面板最多保留多少条消息（超出时从最早的丢，避免 DOM 无限增长） */
const MAX_MESSAGES = 300;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "beeCode.chatView";

  private view: vscode.WebviewView | undefined;
  /** view 作用域的监听器：重建 view 时先释放旧的 */
  private viewDisposables: vscode.Disposable[] = [];
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
    for (const disposable of this.viewDisposables.splice(0)) disposable.dispose();
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    view.webview.html = buildHtml(view.webview, mediaRoot);
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

  /** 重载后恢复聊天记录（不改状态机，只回填视图） */
  restore(messages: ChatMessageView[], mode?: PanelState["mode"]): void {
    this.state.messages = messages.slice(-MAX_MESSAGES);
    if (mode) this.state.mode = mode;
    this.pushState();   // 全量快照：重载/切换会话时才需要
  }

  /** 当前完整消息列表（会话持久化用） */
  getMessages(): ChatMessageView[] {
    return [...this.state.messages];
  }

  getMode(): PanelState["mode"] {
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
      // 裁剪后必须整表重发，否则 DOM 与 state 会漂移
      this.state.messages = this.state.messages.slice(-MAX_MESSAGES);
      this.pushState();
      return;
    }
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

  /** 轻量状态：只带 mode/busy/hint，不动消息列表（高频调用，别每次重发整段历史） */
  pushStatus(): void {
    this.post({ type: "status", mode: this.state.mode, busy: this.state.busy, hint: this.state.hint ?? "" });
  }

  /** 全量快照：webview 刚加载 / 恢复会话 / 消息被裁剪时才发 */
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
        const raw = typeof msg.text === "string" ? msg.text : "";
        if (raw.length > 20_000) {
          this.setHint("输入过长，已截断到 20000 字符。");
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
      case "mode":
        if (msg.mode === "builder" || msg.mode === "debugger" || msg.mode === "chat") {
          this.state.mode = msg.mode;
          this.pushStatus();
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
  <section id="messages" class="messages" aria-live="polite" aria-atomic="false" aria-busy="false" aria-label="对话记录"></section>
  <div id="sr-status" class="sr-only" aria-live="polite" aria-atomic="true"></div>
  <section id="pending" class="pending hidden">
    <div class="pending-head">
      <span id="pending-title">待审提案</span>
      <span class="pending-actions">
        <button id="acceptAll">全部接受</button>
        <button id="rejectAll">全部拒绝</button>
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
