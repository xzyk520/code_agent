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
    proposals: must("proposals", HTMLElement),
    proposalsList: must("proposals-list", HTMLElement),
    srStatus: must("sr-status", HTMLElement),
    proposalsTitle: must("proposals-title", HTMLElement),
    attachments: must("attachments", HTMLElement),
    input: must("input", HTMLTextAreaElement),
    hint: must("hint", HTMLElement),
    send: must("send", HTMLButtonElement),
    stop: must("stop", HTMLButtonElement),
    acceptAll: must("acceptAll", HTMLButtonElement),
    autoBadge: must("auto-badge", HTMLElement),
    reads: must("reads", HTMLElement),
    rejectAll: must("rejectAll", HTMLButtonElement),
  };

  /** @type {NodeListOf<HTMLButtonElement>} */
  const modeButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".mode"));

  /** @typedef {"auto" | "chat" | "builder" | "debugger"} Mode */
  /** @typedef {{ id: string, role: "user" | "assistant" | "system", text: string }} ChatMessage */
  /** @typedef {{ id: string, path: string, additions?: number, deletions?: number, status: string, summary?: string }} Proposal */
  /** @typedef {{ path: string, startLine?: number, endLine?: number, kind?: string }} Attachment */
  /** @typedef {{ mode: Mode, busy: boolean, messages?: ChatMessage[], proposals?: Proposal[], attachments?: Attachment[], hint?: string }} PanelState */

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
   * 屏幕阅读器播报（仅辅助技术可见，视觉上隐藏）。
   *
   * 为什么需要：消息区是 aria-live 区域，流式时每个分片都可能触发播报，非常吵。
   * 所以流式期间用 aria-busy 让 AT「先别念」，结束时再播报一次结果。
   */
  /** @param {string} text */
  function announce(text) {
    // 同样的文本连续设置不会重复播报：先清空再在下一个 tick 写入
    el.srStatus.textContent = "";
    setTimeout(() => {
      el.srStatus.textContent = text;
    }, 30);
  }

  /** 流式期间把消息区标记为 busy —— 只影响播报时机，不影响视觉渲染 */
  /** @param {boolean} busy */
  function setMessagesBusy(busy) {
    el.messages.setAttribute("aria-busy", busy ? "true" : "false");
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

  /**
   * 子代理卡片（按 id 聚合）。
   *
   * 形态参考工业级 agent：一个可折叠的「子代理」块，标题是任务，正文是它调用过的工具，
   * 结束时补一行统计与结论。默认展开（用户想看过程），完成后可折叠。
   */
  const subagents = new Map();

  /**
   * @param {string} id
   * @param {string} task
   */
  function ensureSubagent(id, task) {
    const existing = subagents.get(id);
    if (existing) return existing;

    const wrap = document.createElement("div");
    wrap.className = "msg subagent";

    const details = document.createElement("details");
    details.className = "subagent-card";
    details.open = true;

    const summary = document.createElement("summary");
    summary.className = "subagent-head";

    const icon = document.createElement("span");
    icon.className = "subagent-icon";
    icon.textContent = "◈";

    const taskNode = document.createElement("span");
    taskNode.className = "subagent-task";
    taskNode.textContent = task || "子代理任务";

    const chip = document.createElement("span");
    chip.className = "subagent-chip running";
    chip.textContent = "探索中";

    summary.append(icon, taskNode, chip);

    const body = document.createElement("div");
    body.className = "subagent-body";

    const tools = document.createElement("ul");
    tools.className = "subagent-tools";

    const result = document.createElement("div");
    result.className = "subagent-result";
    result.hidden = true;

    const stats = document.createElement("div");
    stats.className = "subagent-stats";

    const findings = document.createElement("pre");
    findings.className = "subagent-findings";

    result.append(stats, findings);
    body.append(tools, result);
    details.append(summary, body);
    wrap.append(details);
    el.messages.appendChild(wrap);
    el.messages.scrollTop = el.messages.scrollHeight;

    const entry = { details, chip, tools, result, stats, findings, pending: /** @type {Map<string, HTMLElement>} */ (new Map()) };
    subagents.set(id, entry);
    return entry;
  }

  /**
   * @param {string} name
   * @param {string} status
   * @param {string} [summary]
   */
  function toolLine(name, status, summary) {
    const li = document.createElement("li");
    li.className = "subagent-tool " + (status === "start" ? "running" : status === "error" ? "error" : "done");

    const icon = document.createElement("span");
    icon.className = "subagent-tool-icon";
    icon.textContent = status === "start" ? "◌" : status === "error" ? "✕" : "✓";

    const label = document.createElement("span");
    label.className = "subagent-tool-name";
    label.textContent = name;

    const detail = document.createElement("span");
    detail.className = "subagent-tool-detail";
    detail.textContent = summary || "";

    li.append(icon, label, detail);
    return li;
  }

  /** @param {{ [key: string]: unknown }} msg */
  function renderSubagent(msg) {
    const id = typeof msg.id === "string" ? msg.id : "";
    if (!id) return;
    const status = typeof msg.status === "string" ? msg.status : "";
    const task = typeof msg.task === "string" ? msg.task : "";

    if (status === "start") {
      const entry = ensureSubagent(id, task);
      announce("子代理开始：" + (task || "探索代码"));
      return;
    }

    const entry = ensureSubagent(id, task);
    const tool = /** @type {{ name?: unknown, status?: unknown, summary?: unknown } | undefined} */ (msg.tool);
    if (status === "tool" && tool) {
      const name = typeof tool.name === "string" ? tool.name : "tool";
      const toolStatus = typeof tool.status === "string" ? tool.status : "";
      const summary = typeof tool.summary === "string" ? tool.summary : "";
      if (toolStatus === "start") {
        const li = toolLine(name, "start", summary);
        entry.tools.appendChild(li);
        entry.pending.set(name + "\u0000" + summary, li);
      } else {
        const key = name + "\u0000" + summary;
        const li = entry.pending.get(key);
        if (li) {
          li.className = "subagent-tool " + (toolStatus === "error" ? "error" : "done");
          const icon = li.querySelector(".subagent-tool-icon");
          if (icon) icon.textContent = toolStatus === "error" ? "✕" : "✓";
          entry.pending.delete(key);
        } else {
          entry.tools.appendChild(toolLine(name, toolStatus, summary));
        }
      }
      el.messages.scrollTop = el.messages.scrollHeight;
      return;
    }

    if (status === "end") {
      const error = typeof msg.error === "string" ? msg.error : "";
      entry.chip.className = "subagent-chip " + (error ? "error" : "done");
      entry.chip.textContent = error ? "失败" : "完成";
      entry.details.open = !error;

      const steps = typeof msg.steps === "number" ? msg.steps : 0;
      const toolCalls = typeof msg.toolCalls === "number" ? msg.toolCalls : 0;
      entry.stats.textContent = error
        ? "失败：" + error
        : "完成 · " + steps + " 步 · " + toolCalls + " 次工具调用";

      const findings = typeof msg.findings === "string" ? msg.findings : "";
      if (findings) {
        entry.findings.textContent = findings;
        entry.findings.hidden = false;
        entry.result.hidden = false;
      } else if (!error) {
        entry.findings.hidden = true;
        entry.result.hidden = false;
      }
      announce(error ? "子代理失败：" + error : "子代理完成，共 " + steps + " 步");
      el.messages.scrollTop = el.messages.scrollHeight;
    }
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
          : state.mode === "auto"
            ? "直接说你想做什么，会自动判断模式…（Ctrl+Enter 发送）"
            : "问点什么…（Ctrl+Enter 发送）";

    // 只有 auto 模式才显示"自动：X"角标
    if (state.mode !== "auto") el.autoBadge.hidden = true;
  }

  /** @param {{ mode?: string, auto?: boolean, reason?: string }} p */
  function renderModeBadge(p) {
    if (state.mode !== "auto" || !p.auto) {
      el.autoBadge.hidden = true;
      return;
    }
    const label = p.mode === "builder" ? "Builder" : p.mode === "debugger" ? "Debugger" : "Chat";
    el.autoBadge.hidden = false;
    el.autoBadge.textContent = "自动：" + label;
    el.autoBadge.title = String(p.reason || "");
  }

  /** agent 读过文件的 chip（同路径只保留一个，重复读时更新行号并闪烁） */
  const readChips = new Map();

  /** @param {{ path?: unknown, startLine?: unknown, endLine?: unknown }} item */
  function renderRead(item) {
    const path = typeof item.path === "string" ? item.path : "";
    if (!path) return;
    const name = path.split("/").pop() || path;
    const start = typeof item.startLine === "number" ? item.startLine : undefined;
    const end = typeof item.endLine === "number" ? item.endLine : undefined;

    let chip = readChips.get(path);
    if (!chip) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.className = "read-chip";
      chip.addEventListener("click", () => {
        const startLine = chip.dataset.start ? Number(chip.dataset.start) : undefined;
        const endLine = chip.dataset.end ? Number(chip.dataset.end) : undefined;
        post({ type: "openRead", path: chip.dataset.path, startLine, endLine });
      });
      el.reads.appendChild(chip);
      readChips.set(path, chip);
      // 只保留最近 8 个，避免占满一行
      while (readChips.size > 8) {
        const oldest = readChips.keys().next().value;
        const node = readChips.get(oldest);
        if (node) node.remove();
        readChips.delete(oldest);
      }
    }
    chip.textContent = start && end ? `${name}:${start}-${end}` : name;
    chip.title = start && end ? `${path} 第 ${start}-${end} 行（点击打开）` : `${path}（点击打开）`;
    chip.dataset.path = path;
    if (start) chip.dataset.start = String(start);
    else delete chip.dataset.start;
    if (end) chip.dataset.end = String(end);
    else delete chip.dataset.end;
    chip.setAttribute("aria-label", `打开 ${path}${start && end ? ` 第 ${start} 到 ${end} 行` : ""}`);

    // 重新触发动效：先移除再强制回流
    chip.classList.remove("flash");
    void chip.offsetWidth;
    chip.classList.add("flash");
    setTimeout(() => chip.classList.remove("flash"), 1_200);
  }

  /**
   * 计划清单：同一轮内反复 update_plan 时复用同一个节点。
   * @type {HTMLElement | null}
   */
  let planNode = null;

  /** @param {Array<{ text?: unknown, status?: unknown }>} steps */
  function renderPlan(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return;
    if (!planNode) {
      planNode = document.createElement("div");
      planNode.className = "msg plan";
      const title = document.createElement("div");
      title.className = "plan-title";
      title.textContent = "计划";
      const list = document.createElement("ol");
      list.className = "plan-steps";
      planNode.append(title, list);
      el.messages.appendChild(planNode);
    }
    const list = planNode.querySelector(".plan-steps");
    if (!list) return;
    list.textContent = "";
    for (const step of steps) {
      const text = typeof step.text === "string" ? step.text : "";
      if (!text) continue;
      const status = typeof step.status === "string" ? step.status : "pending";
      const li = document.createElement("li");
      li.className = "plan-step " + (status === "done" ? "done" : status === "doing" ? "doing" : "pending");
      const icon = document.createElement("span");
      icon.className = "plan-icon";
      icon.textContent = status === "done" ? "✓" : status === "doing" ? "▶" : "○";
      const body = document.createElement("span");
      body.textContent = text;
      li.append(icon, body);
      list.appendChild(li);
    }
    el.messages.scrollTop = el.messages.scrollHeight;
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

  /**
   * 提案卡片：每个文件一张，三个动作（看 diff / 接受 / 拒绝）。
   * 接受之前磁盘一字不动 —— 这正是"先预览、后落实"的模型。
   * @param {Proposal[]} items
   */
  function renderProposals(items) {
    el.proposals.classList.toggle("hidden", items.length === 0);
    el.proposalsTitle.textContent = "待审提案（" + items.length + " 个文件）";
    el.proposalsList.textContent = "";

    for (const item of items) {
      const stale = item.status === "stale";
      const li = document.createElement("li");
      li.className = stale ? "proposal stale" : "proposal";

      const head = document.createElement("div");
      head.className = "proposal-head";

      const pathNode = document.createElement("span");
      pathNode.className = "path";
      pathNode.textContent = item.path;
      pathNode.title = item.summary || item.path;

      const stat = document.createElement("span");
      stat.className = "stat";
      stat.textContent = stale ? "已失效" : "+" + (item.additions || 0) + " −" + (item.deletions || 0);

      head.appendChild(pathNode);
      head.appendChild(stat);

      if (item.summary) {
        const note = document.createElement("div");
        note.className = "proposal-note";
        note.textContent = item.summary;
        li.appendChild(head);
        li.appendChild(note);
      } else {
        li.appendChild(head);
      }

      const actions = document.createElement("div");
      actions.className = "proposal-actions";

      const view = document.createElement("button");
      view.textContent = "查看改动";
      view.addEventListener("click", () => post({ type: "proposal.diff", id: item.id }));

      actions.appendChild(view);

      // 失效的提案不能再接受（内容已不是基于最新文件），只能查看或丢弃
      if (!stale) {
        const accept = document.createElement("button");
        accept.className = "primary";
        accept.textContent = "接受";
        accept.addEventListener("click", () => post({ type: "accept", ids: [item.id] }));
        actions.appendChild(accept);
      }

      const reject = document.createElement("button");
      reject.textContent = stale ? "丢弃" : "拒绝";
      reject.addEventListener("click", () => post({ type: "reject", ids: [item.id] }));
      actions.appendChild(reject);
      li.appendChild(actions);
      el.proposalsList.appendChild(li);
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
  el.acceptAll.addEventListener("click", () => post({ type: "acceptAll" }));
  el.rejectAll.addEventListener("click", () => post({ type: "rejectAll" }));

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
        subagents.clear();
        planNode = null;
        readChips.clear();
        el.reads.textContent = "";
        renderMode();
        renderBusy();
        renderAttachments(next.attachments || []);
        renderProposals(next.proposals || []);
        el.hint.textContent = next.hint || "";
        break;
      }
      case "status": {
        // 轻量状态：绝不重渲染消息列表（否则流式中的回复会被清掉）
        state.mode = /** @type {Mode} */ (msg.mode);
        state.busy = Boolean(msg.busy);
        if (!state.busy) setMessagesBusy(false);   // 兜底：本轮结束一定要解除 busy
        renderMode();
        renderBusy();
        el.hint.textContent = String(msg.hint ?? "");
        break;
      }
      case "message": {
        const message = /** @type {ChatMessage} */ (msg.message);
        if (message.role === "assistant" && streamingNode) {
          // 收尾：壳发来的全文是权威版本，直接覆盖流式累积的内容，不再追加一条
          streamingNode.textContent = message.text;
          clearStreaming();
        subagents.clear();
        planNode = null;
        readChips.clear();
        el.reads.textContent = "";
          setMessagesBusy(false);   // 流式结束：现在可以播报了
          announce("助手回复完成，共 " + message.text.length + " 字");
          break;
        }
        if (message.role === "user") clearStreaming();
        addMessage(message.role, message.text);
        if (message.role === "system") announce("系统消息：" + message.text);
        break;
      }
      case "delta": {
        const text = String(msg.text ?? "");
        if (!streamingNode) {
          streamingNode = addMessage("assistant", "");
          setMessagesBusy(true);   // 开始流式：先不自动播报
          announce("助手开始回复");
        }
        streamingNode.textContent += text;
        el.messages.scrollTop = el.messages.scrollHeight;
        break;
      }


      case "attachments": {
        renderAttachments(/** @type {Attachment[]} */ (msg.items) || []);
        break;
      }
      case "proposals": {
        const items = /** @type {Proposal[]} */ (msg.items) || [];
        renderProposals(items);
        if (items.length > 0) announce("待审提案 " + items.length + " 个");
        break;
      }
      case "mode": {
        renderModeBadge(/** @type {{ mode?: string, auto?: boolean, reason?: string }} */ (msg));
        break;
      }
      case "reads": {
        renderRead(/** @type {{ path?: unknown, startLine?: unknown, endLine?: unknown }} */ (msg.item));
        break;
      }
      case "plan": {
        renderPlan(/** @type {Array<{ text?: unknown, status?: unknown }>} */ (msg.steps));
        break;
      }
      case "subagent": {
        renderSubagent(msg);
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
