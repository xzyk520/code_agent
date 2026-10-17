// @ts-check
/* Bee Code 面板前端：纯浏览器 JS，不打包。
 * 只做渲染 + 把用户动作 postMessage 回扩展；不含任何业务逻辑。 */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    messages: document.getElementById("messages"),
    pending: document.getElementById("pending"),
    pendingList: document.getElementById("pending-list"),
    pendingTitle: document.getElementById("pending-title"),
    attachments: document.getElementById("attachments"),
    input: /** @type {HTMLTextAreaElement} */ (document.getElementById("input")),
    hint: document.getElementById("hint"),
    send: document.getElementById("send"),
    stop: document.getElementById("stop"),
    keepAll: document.getElementById("keepAll"),
    undoAll: document.getElementById("undoAll"),
    modes: /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".mode")),
  };

  /** @type {{mode: string, busy: boolean}} */
  let state = { mode: "chat", busy: false };
  /** @type {HTMLElement | null} */
  let streamingNode = null;

  function post(message) {
    vscode.postMessage(message);
  }

  function clearStreaming() {
    streamingNode = null;
  }

  function addMessage(role, text, extraClass) {
    const node = document.createElement("div");
    node.className = "msg " + role + (extraClass ? " " + extraClass : "");
    node.textContent = text;
    el.messages.appendChild(node);
    el.messages.scrollTop = el.messages.scrollHeight;
    return node;
  }

  function renderMode() {
    for (const button of el.modes) {
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

  function renderAttachments(items) {
    el.attachments.textContent = "";
    for (const item of items || []) {
      const chip = document.createElement("span");
      chip.className = "chip";
      const range = item.startLine && item.endLine ? `:${item.startLine}-${item.endLine}` : "";
      chip.textContent = (item.path || "").split(/[\\/]/).pop() + range;
      chip.title = item.path + range;
      el.attachments.appendChild(chip);
    }
  }

  function renderPending(items) {
    const list = items || [];
    el.pending.classList.toggle("hidden", list.length === 0);
    el.pendingTitle.textContent = "待审改动（" + list.length + "）";
    el.pendingList.textContent = "";

    for (const item of list) {
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

  for (const button of el.modes) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (mode) post({ type: "mode", mode: mode });
    });
  }

  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case "state": {
        state = msg.state;
        el.messages.textContent = "";
        for (const item of msg.state.messages || []) {
          addMessage(item.role, item.text);
        }
        clearStreaming();
        renderMode();
        renderBusy();
        renderAttachments(msg.state.attachments);
        renderPending(msg.state.pending);
        el.hint.textContent = msg.state.hint || "";
        break;
      }
      case "message": {
        addMessage(msg.message.role, msg.message.text);
        break;
      }
      case "delta": {
        if (!streamingNode) streamingNode = addMessage("assistant", "");
        streamingNode.textContent += msg.text;
        el.messages.scrollTop = el.messages.scrollHeight;
        break;
      }
      case "final": {
        clearStreaming();
        break;
      }
      case "busy": {
        state.busy = !!msg.busy;
        if (state.busy) clearStreaming();
        renderBusy();
        break;
      }
      case "attachments": {
        renderAttachments(msg.items);
        break;
      }
      case "pending": {
        renderPending(msg.items);
        break;
      }
      case "hint": {
        el.hint.textContent = msg.text || "";
        break;
      }
      case "error": {
        addMessage("system", "⚠ " + msg.text, "error");
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
