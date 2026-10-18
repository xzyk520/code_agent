// @ts-check
/* Bee Code 面板前端：纯浏览器 JS，不打包。
 * 只做渲染 + 把用户动作 postMessage 回扩展；不含任何业务逻辑。
 * 类型检查走 tsconfig.webview.json（lib 含 DOM，不含 node/vscode）。 */
(function () {
  const vscode = acquireVsCodeApi();

  /**
   * 取元素，取不到就立刻抛错 —— 比「静默 null」好查得多。
   * @template {Element} T
   * @param {string} id
   * @param {new () => T} ctor
   * @returns {T}
   */
  function must(id, ctor) {
    const node = document.getElementById(id);
    if (!(node instanceof ctor)) throw new Error("面板缺少元素 #" + id);
    return node;
  }

  const el = {
    messages: must("messages", HTMLElement),
    pending: must("pending", HTMLElement),
    pendingList: must("pending-list", HTMLElement),
    pendingTitle: must("pending-title", HTMLElement),
    attachments: must("attachments", HTMLElement),
    input: must("input", HTMLTextAreaElement),
    hint: must("hint", HTMLElement),
    send: must("send", HTMLButtonElement),
    stop: must("stop", HTMLButtonElement),
    keepAll: must("keepAll", HTMLButtonElement),
    undoAll: must("undoAll", HTMLButtonElement),
  };

  /** @type {NodeListOf<HTMLButtonElement>} */
  const modeButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".mode"));

  /** @typedef {"chat" | "builder" | "debugger"} Mode */
  /** @typedef {{ id: string, role: "user" | "assistant" | "system", text: string }} ChatMessage */
  /** @typedef {{ id: string, path: string, symbolPath?: string, additions?: number, deletions?: number, risk?: string, status: string }} PendingItem */
  /** @typedef {{ path: string, startLine?: number, endLine?: number, kind?: string }} Attachment */
  /** @typedef {{ mode: Mode, busy: boolean, messages?: ChatMessage[], pending?: PendingItem[], attachments?: Attachment[], hint?: string }} PanelState */

  /** @type {{ mode: Mode, busy: boolean }} */
  let state = { mode: "chat", busy: false };
  /** @type {HTMLElement | null} */
  let streamingNode = null;

  /** @param {unknown} message */
  function post(message) {
    vscode.postMessage(message);
  }

  function clearStreaming() {
    streamingNode = null;
  }

  /**
   * @param {string} role
   * @param {string} text
   * @param {string} [extraClass]
   * @returns {HTMLElement}
   */
  function addMessage(role, text, extraClass) {
    const node = document.createElement("div");
    node.className = "msg " + role + (extraClass ? " " + extraClass : "");
    node.textContent = text;
    el.messages.appendChild(node);
    el.messages.scrollTop = el.messages.scrollHeight;
    return node;
  }

  function renderMode() {
    for (const button of modeButtons) {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    }
    el.input.placeholder =
      state.mode === "builder"
        ? "描述要实现的改动…（Ctrl+Enter 发送）"
        : state.mode === "debugger"
          ? "描述报错/异常现象…（Ctrl+Enter 发送）"
          : "问点什么…（Ctrl+Enter 发送）";
  }

  function renderBusy() {
    el.stop.disabled = !state.busy;
    el.send.disabled = state.busy;
  }

  /** @param {Attachment[]} items */
  function renderAttachments(items) {
    el.attachments.textContent = "";
    for (const item of items) {
      const chip = document.createElement("span");
      chip.className = "chip";
      const range = item.startLine && item.endLine ? ":" + item.startLine + "-" + item.endLine : "";
      chip.textContent = (item.path || "").split(/[\\/]/).pop() + range;
      chip.title = item.path + range;
      el.attachments.appendChild(chip);
    }
  }

  /** @param {PendingItem[]} items */
  function renderPending(items) {
    el.pending.classList.toggle("hidden", items.length === 0);
    el.pendingTitle.textContent = "待审改动（" + items.length + "）";
    el.pendingList.textContent = "";

    for (const item of items) {
      const li = document.createElement("li");

      const pathNode = document.createElement("span");
      pathNode.className = "path";
      pathNode.textContent = item.symbolPath ? item.path + " › " + item.symbolPath : item.path;
      pathNode.title = item.path;

      const stat = document.createElement("span");
      stat.className = "stat";
      stat.textContent = "+" + (item.additions || 0) + " −" + (item.deletions || 0);

      const keep = document.createElement("button");
      keep.textContent = "Keep";
      keep.addEventListener("click", () => post({ type: "keep", ids: [item.id] }));

      const undo = document.createElement("button");
      undo.textContent = "Undo";
      undo.addEventListener("click", () => post({ type: "undo", ids: [item.id] }));

      li.appendChild(pathNode);
      li.appendChild(stat);
      if (item.risk === "high") {
        const risk = document.createElement("span");
        risk.className = "risk-high";
        risk.textContent = "⚠";
        risk.title = "高风险改动";
        li.appendChild(risk);
      }
      li.appendChild(keep);
      li.appendChild(undo);
      el.pendingList.appendChild(li);
    }
  }

  function send() {
    const text = el.input.value.trim();
    if (!text || state.busy) return;
    post({ type: "send", text: text, mode: state.mode });
    el.input.value = "";
  }

  el.send.addEventListener("click", send);
  el.stop.addEventListener("click", () => post({ type: "stop" }));
  el.keepAll.addEventListener("click", () => post({ type: "keepAll" }));
  el.undoAll.addEventListener("click", () => post({ type: "undoAll" }));

  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (mode === "chat" || mode === "builder" || mode === "debugger") post({ type: "mode", mode: mode });
    });
  }

  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  });

  window.addEventListener("message", (event) => {
    /** @type {{ type?: string, [key: string]: unknown }} */
    const msg = event.data || {};
    if (typeof msg.type !== "string") return;

    switch (msg.type) {
      case "state": {
        const next = /** @type {PanelState} */ (msg.state);
        state = { mode: next.mode, busy: next.busy };
        el.messages.textContent = "";
        for (const item of next.messages || []) {
          addMessage(item.role, item.text);
        }
        clearStreaming();
        renderMode();
        renderBusy();
        renderAttachments(next.attachments || []);
        renderPending(next.pending || []);
        el.hint.textContent = next.hint || "";
        break;
      }
      case "message": {
        const message = /** @type {ChatMessage} */ (msg.message);
        addMessage(message.role, message.text);
        break;
      }
      case "delta": {
        const text = String(msg.text ?? "");
        if (!streamingNode) streamingNode = addMessage("assistant", "");
        streamingNode.textContent += text;
        el.messages.scrollTop = el.messages.scrollHeight;
        break;
      }
      case "final": {
        clearStreaming();
        break;
      }
      case "busy": {
        state.busy = Boolean(msg.busy);
        if (state.busy) clearStreaming();
        renderBusy();
        break;
      }
      case "attachments": {
        renderAttachments(/** @type {Attachment[]} */ (msg.items) || []);
        break;
      }
      case "pending": {
        renderPending(/** @type {PendingItem[]} */ (msg.items) || []);
        break;
      }
      case "hint": {
        el.hint.textContent = String(msg.text ?? "");
        break;
      }
      case "error": {
        addMessage("system", "⚠ " + String(msg.text ?? ""), "error");
        break;
      }
      default:
        break;
    }
  });

  renderMode();
  renderBusy();
  post({ type: "ready" });
})();
