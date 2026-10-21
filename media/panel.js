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
    modeBadge: must("mode-badge", HTMLElement),
    cost: must("cost", HTMLElement),
    trajectory: must("trajectory", HTMLElement),
    trajectoryList: must("trajectory-list", HTMLElement),
    trajectoryFilter: must("trajectory-filter", HTMLInputElement),
    reads: must("reads", HTMLElement),
    rejectAll: must("rejectAll", HTMLButtonElement),
  };


  /** @typedef {"chat" | "builder" | "debugger"} Mode */
  /** @typedef {{ id: string, role: "user" | "assistant" | "system", text: string, reasoning?: string, diagrams?: Array<{ id: string, kind: string, title?: string, source: string }> }} ChatMessage */
  /** @typedef {{ id: string, path: string, additions?: number, deletions?: number, status: string, summary?: string }} Proposal */
  /** @typedef {{ path: string, startLine?: number, endLine?: number, kind?: string }} Attachment */
  /** @typedef {{ mode: Mode, busy: boolean, messages?: ChatMessage[], proposals?: Proposal[], attachments?: Attachment[], plan?: Array<{ text: string, status: string }>, turns?: Array<{ userMessageId?: string, status?: string, error?: string, inputTokens?: number, outputTokens?: number, elapsedMs?: number, trace?: Array<any> }>, hint?: string }} PanelState */

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
   * @param {string} [id]
   * @returns {HTMLElement}
   */
  function addMessage(role, text, extraClass, id) {
    const node = document.createElement("div");
    node.className = "msg " + role + (extraClass ? " " + extraClass : "");
    node.textContent = text;
    if (id) node.dataset.messageId = id;
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
  /** 模式完全由意图分析决定：这里只显示徽标 + 调整输入提示 */
  function renderMode() {
    const label = state.mode === "builder" ? "Builder" : state.mode === "debugger" ? "Debugger" : "Chat";
    el.modeBadge.textContent = label;
    el.modeBadge.title = "模式由意图分析自动选择";
    el.input.placeholder =
      state.mode === "builder"
        ? "描述要实现的改动…（Ctrl+Enter 发送）"
        : state.mode === "debugger"
          ? "描述报错/异常现象…（Ctrl+Enter 发送）"
          : "直接说你想做什么（模式会自动判断）…（Ctrl+Enter 发送）";
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

  /** 一轮的轨迹卡片：默认折叠；外层摘要 + 内层步骤 + 完整内容三层 */
  function formatUsage(turn) {
    const tokens = (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0);
    const seconds = (turn.elapsedMs ?? 0) / 1000;
    const parts = [];
    if (tokens > 0) parts.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`);
    if (seconds > 0) parts.push(`${seconds.toFixed(1)}s`);
    return parts.join(" · ");
  }

  function traceStepNode(step) {
    const details = document.createElement("details");
    details.className = "trace-step";
    const summary = document.createElement("summary");
    summary.className = "trace-step-title";
    const body = document.createElement("div");
    body.className = "trace-step-body";

    const type = step && step.type;
    const text = typeof step?.text === "string" ? step.text : "";
    const detail = typeof step?.detail === "string" ? step.detail : "";
    const args = typeof step?.args === "string" ? step.args : "";
    const summaryText = typeof step?.summary === "string" ? step.summary : "";
    const preview = (summaryText || text || detail || args || "").replace(/\s+/g, " ").slice(0, 120);
    let label = "步骤";
    if (type === "reasoning") label = `思考 · 第 ${step.round ?? 1} 次`;
    else if (type === "tool") label = `工具 · ${step.name ?? "?"}${step.status ? ` · ${step.status}` : ""}`;
    else if (type === "diagram") label = `图 · ${step.title || step.name || "mermaid"}`;
    else if (type === "error") label = "错误";
    summary.textContent = `${label}${preview ? ` · ${preview}` : ""}`;

    const short = document.createElement("pre");
    short.className = "trace-preview";
    short.textContent = (summaryText || text || detail || args || "（无内容）").slice(0, 800);
    body.appendChild(short);

    const fullText = [summaryText, args, text, detail].filter(Boolean).join("\n\n");
    if (fullText.length > 800) {
      const full = document.createElement("details");
      full.className = "trace-full";
      const fullSummary = document.createElement("summary");
      fullSummary.textContent = "查看完整内容";
      const pre = document.createElement("pre");
      pre.className = "trace-full-body";
      pre.textContent = fullText;
      full.append(fullSummary, pre);
      body.appendChild(full);
    }

    details.append(summary, body);
    return details;
  }

  function renderTraceCard(turn) {
    if (!turn) return;
    const card = document.createElement("details");
    card.className = "trace-card" + (turn.status === "error" ? " trace-error-card" : "");
    const summary = document.createElement("summary");
    summary.className = "trace-summary";
    const usage = formatUsage(turn);
    summary.textContent = `${turn.status === "error" ? "任务失败" : "任务已完成"}${usage ? ` · ${usage}` : ""}`;
    const body = document.createElement("div");
    body.className = "trace-body";
    const steps = Array.isArray(turn.trace) ? turn.trace : [];
    if (steps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "trace-empty";
      empty.textContent = "本轮没有工具调用或思考记录。";
      body.appendChild(empty);
    }
    for (const step of steps) body.appendChild(traceStepNode(step));
    if (turn.error) {
      const error = document.createElement("div");
      error.className = "trace-error";
      error.textContent = `错误：${turn.error}`;
      body.appendChild(error);
    }
    card.append(summary, body);
    el.messages.appendChild(card);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  /** ── Mermaid：只有出现图时才懒加载（历史会话打开 / 本轮新图） ── */
  const SCRIPT_NONCE = document.currentScript && document.currentScript.nonce ? document.currentScript.nonce : "";
  let mermaidPromise = null;
  let diagramSeq = 0;

  function getMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise((resolve, reject) => {
      const uri = document.body.dataset.mermaidUri;
      if (!uri) {
        reject(new Error("缺少 Mermaid 资源"));
        return;
      }
      const script = document.createElement("script");
      script.src = uri;
      if (SCRIPT_NONCE) script.nonce = SCRIPT_NONCE;
      script.onload = () => {
        try {
          window.mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            htmlLabels: false,
            theme: "dark",
            flowchart: { htmlLabels: false, useMaxWidth: true },
          });
          resolve(window.mermaid);
        } catch (err) {
          reject(err);
        }
      };
      script.onerror = () => reject(new Error("Mermaid 加载失败"));
      document.head.appendChild(script);
    });
    return mermaidPromise;
  }

  /** @param {{ id?: string, kind?: string, title?: string, source?: string }} diagram */
  function renderDiagramCard(diagram) {
    if (!diagram || typeof diagram.source !== "string" || !diagram.source.trim()) return;
    const card = document.createElement("div");
    card.className = "msg diagram-card";
    const head = document.createElement("div");
    head.className = "diagram-head";
    const title = document.createElement("span");
    title.className = "diagram-title";
    title.textContent = diagram.title || `${diagram.kind || "diagram"} 图`;
    const kind = document.createElement("span");
    kind.className = "diagram-kind";
    kind.textContent = diagram.kind || "mermaid";
    head.append(title, kind);
    const body = document.createElement("div");
    body.className = "diagram-body";
    body.textContent = "正在加载渲染器…";
    card.append(head, body);
    el.messages.appendChild(card);
    el.messages.scrollTop = el.messages.scrollHeight;

    const seq = ++diagramSeq;
    getMermaid()
      .then((mermaid) => mermaid.render(`bee-diagram-${seq}`, diagram.source))
      .then((result) => {
        if (!card.isConnected) return;
        body.textContent = "";
        body.innerHTML = result && result.svg ? result.svg : "";
      })
      .catch((err) => {
        if (!card.isConnected) return;
        body.textContent = "";
        const note = document.createElement("div");
        note.className = "diagram-error";
        note.textContent = "渲染失败：" + (err instanceof Error ? err.message : String(err));
        const pre = document.createElement("pre");
        pre.className = "diagram-source";
        pre.textContent = diagram.source;
        body.append(note, pre);
      });
  }

  /** 思考内容：按"第几次模型调用"分段显示（只展示，不进上下文，但会随消息落盘） */
  /** @type {Map<number, { node: HTMLDetailsElement, body: HTMLElement }>} */
  const reasoningBlocks = new Map();

  function clearLiveReasoning() {
    for (const entry of reasoningBlocks.values()) entry.node.remove();
    reasoningBlocks.clear();
  }

  function resetReasoning() {
    clearLiveReasoning();
  }

  /** @param {number} round @param {string} text */
  function reasoningDelta(text, round) {
    if (!text) return;
    const key = typeof round === "number" && round > 0 ? round : 1;
    let entry = reasoningBlocks.get(key);
    if (!entry) {
      const node = document.createElement("details");
      node.className = "msg reasoning";
      node.open = true;
      const summary = document.createElement("summary");
      summary.className = "reasoning-title";
      summary.textContent = key > 1 ? `思考过程 · 第 ${key} 次调用` : "思考过程";
      const body = document.createElement("div");
      body.className = "reasoning-body";
      node.append(summary, body);
      el.messages.appendChild(node);
      entry = { node, body };
      reasoningBlocks.set(key, entry);
    }
    entry.body.textContent += text;
    setMessagesBusy(true);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function collapseLiveReasoning() {
    for (const entry of reasoningBlocks.values()) entry.node.open = false;
  }

  /** @param {string} title @param {string} text */
  function appendReasoningBlock(title, text) {
    if (!text) return;
    const details = document.createElement("details");
    details.className = "msg reasoning";
    details.open = false;
    const summary = document.createElement("summary");
    summary.className = "reasoning-title";
    summary.textContent = title;
    const body = document.createElement("div");
    body.className = "reasoning-body";
    body.textContent = text;
    details.append(summary, body);
    el.messages.appendChild(details);
  }

  /** @param {string | Array<{ round?: number, text?: string }> } reasoning */
  function appendPersistedReasoning(reasoning) {
    if (typeof reasoning === "string") {
      appendReasoningBlock("思考过程", reasoning);
      return;
    }
    if (!Array.isArray(reasoning)) return;
    for (const segment of reasoning) {
      const text = typeof segment?.text === "string" ? segment.text : "";
      const round = typeof segment?.round === "number" ? segment.round : 1;
      appendReasoningBlock(round > 1 ? `思考过程 · 第 ${round} 次调用` : "思考过程", text);
    }
  }

  /** 右侧会话轨迹：按意图列出每一轮，点击跳到对应消息 */
  /** @type {Array<{ id: string, mode: string, intent: string }>} */
  let trajectoryItems = [];

  /** @param {{ id?: unknown, mode?: unknown, intent?: unknown, detail?: unknown }} item */
  function appendTrajectoryButton(item) {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return;
    const mode = typeof item.mode === "string" ? item.mode : "chat";
    const intent = typeof item.intent === "string" ? item.intent : "";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "trajectory-item mode-" + mode;
    button.dataset.target = id;
    button.dataset.intent = intent.toLowerCase();
    button.title = intent;
    const dot = document.createElement("span");
    dot.className = "trajectory-dot";
    dot.textContent = mode === "builder" ? "◆" : mode === "debugger" ? "●" : "○";
    const label = document.createElement("span");
    label.className = "trajectory-label";
    label.textContent = intent || "（未记录意图）";
    button.append(dot, label);
    const detail = typeof item.detail === "string" ? item.detail : "";
    if (detail) {
      const cost = document.createElement("span");
      cost.className = "trajectory-cost";
      cost.textContent = detail;
      button.append(cost);
      button.title = `${intent}\n${detail}`;
    }
    button.addEventListener("click", () => {
      const node = Array.from(el.messages.querySelectorAll("[data-message-id]")).find(
        (candidate) => /** @type {HTMLElement} */ (candidate).dataset.messageId === id,
      );
      if (!(node instanceof HTMLElement)) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.remove("trajectory-flash");
      void node.offsetWidth;
      node.classList.add("trajectory-flash");
      setTimeout(() => node.classList.remove("trajectory-flash"), 1_400);
    });
    el.trajectoryList.appendChild(button);
  }

  /** @param {Array<{ id?: unknown, mode?: unknown, intent?: unknown, detail?: unknown }>} items */
  function renderTrajectory(items) {
    trajectoryItems = [];
    el.trajectoryList.textContent = "";
    for (const item of items) {
      if (typeof item.id !== "string") continue;
      trajectoryItems.push({
        id: item.id,
        mode: typeof item.mode === "string" ? item.mode : "chat",
        intent: typeof item.intent === "string" ? item.intent : "",
      });
      appendTrajectoryButton(item);
    }
    el.trajectoryList.scrollTop = el.trajectoryList.scrollHeight;
  }

  /** 轨迹搜索：按意图文本过滤（大小写无关） */
  function applyTrajectoryFilter() {
    const query = el.trajectoryFilter.value.trim().toLowerCase();
    for (const element of el.trajectoryList.querySelectorAll(".trajectory-item")) {
      if (!(element instanceof HTMLElement)) continue;
      const intent = element.dataset.intent || "";
      element.hidden = query.length > 0 && !intent.includes(query);
    }
  }

  el.trajectoryFilter.addEventListener("input", applyTrajectoryFilter);

  /** @param {{ id?: unknown, mode?: unknown, intent?: unknown, detail?: unknown }} item */
  function addTrajectoryItem(item) {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || trajectoryItems.some((existing) => existing.id === id)) return;
    trajectoryItems.push({
      id,
      mode: typeof item.mode === "string" ? item.mode : "chat",
      intent: typeof item.intent === "string" ? item.intent : "",
    });
    appendTrajectoryButton(item);
    el.trajectory.scrollTop = el.trajectory.scrollHeight;
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
        const turnsByUser = new Map();
        for (const turn of next.turns || []) {
          if (turn && typeof turn.userMessageId === "string") turnsByUser.set(turn.userMessageId, turn);
        }
        let currentTurn = null;
        for (const item of next.messages || []) {
          if (item.role === "user") {
            if (item.text) addMessage(item.role, item.text, undefined, item.id);
            currentTurn = turnsByUser.get(item.id) || null;
            if (currentTurn && (Array.isArray(currentTurn.trace) || currentTurn.error)) renderTraceCard(currentTurn);
            continue;
          }
          if (item.role === "system" && currentTurn && currentTurn.error && item.text === currentTurn.error) {
            continue;   // 错误已经在轨迹卡片里展示，避免重复气泡
          }
          if (item.role === "assistant" && currentTurn) {
            if (!currentTurn.error) {
              if (!(currentTurn.trace || []).some((/** @type {any} */ step) => step && step.type === "reasoning") && item.reasoning) {
                appendPersistedReasoning(item.reasoning);
              }
              if (item.text) addMessage(item.role, item.text, undefined, item.id);
            }
            for (const diagram of item.diagrams || []) renderDiagramCard(diagram);
            const usage = formatUsage(currentTurn);
            if (usage) {
              const usageNode = document.createElement("div");
              usageNode.className = "msg-usage";
              usageNode.textContent = usage;
              el.messages.appendChild(usageNode);
            }
            currentTurn = null;
            continue;
          }
          if (item.reasoning) appendPersistedReasoning(item.reasoning);
          if (item.text) addMessage(item.role, item.text, undefined, item.id);
          for (const diagram of item.diagrams || []) renderDiagramCard(diagram);
        }
        el.trajectoryList.textContent = "";
        trajectoryItems = [];
        clearLiveReasoning();
        clearStreaming();
        subagents.clear();
        planNode = null;
        readChips.clear();
        el.reads.textContent = "";
        if (next.plan && next.plan.length > 0) renderPlan(next.plan);
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
          setMessagesBusy(false);   // 流式结束：现在可以播报了
          announce("助手回复完成，共 " + message.text.length + " 字");
          break;
        }
        if (message.role === "user") clearStreaming();
        if (message.reasoning) appendPersistedReasoning(message.reasoning);
        if (message.text) addMessage(message.role, message.text, undefined, message.id);
        for (const diagram of message.diagrams || []) renderDiagramCard(diagram);
        if (message.role === "system") announce("系统消息：" + message.text);
        break;
      }
      case "delta": {
        const text = String(msg.text ?? "");
        // 正文开始：把思考块自动收起（用户仍可展开回看）
        collapseLiveReasoning();
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

      case "reads": {
        renderRead(/** @type {{ path?: unknown, startLine?: unknown, endLine?: unknown }} */ (msg.item));
        break;
      }
      case "diagram": {
        renderDiagramCard(/** @type {{ id?: string, kind?: string, title?: string, source?: string }} */ (msg.diagram));
        break;
      }
      case "reasoning": {
        reasoningDelta(String(msg.text ?? ""), Number(msg.round ?? 1));
        break;
      }
      case "reasoningReset": {
        resetReasoning();
        break;
      }
      case "cost": {
        el.cost.textContent = String(msg.text ?? "");
        break;
      }
      case "trajectory": {
        renderTrajectory(/** @type {Array<{ id?: unknown, mode?: unknown, intent?: unknown, detail?: unknown }>} */ (msg.items) || []);
        applyTrajectoryFilter();
        break;
      }
      case "trajectoryItem": {
        addTrajectoryItem(/** @type {{ id?: unknown, mode?: unknown, intent?: unknown, detail?: unknown }} */ (msg.item));
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
