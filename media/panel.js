// @ts-check
/* Bee Code panel front-end: plain browser JS, no bundler.
 * Renders only and posts user actions back to the extension; contains no business logic.
 * Type-checked with tsconfig.webview.json (lib includes DOM, not node/vscode). */
(function () {
  const vscode = acquireVsCodeApi();

  /**
   * Get an element and throw immediately if it is missing — far easier to debug than a silent null.
   * @template {Element} T
   * @param {string} id
   * @param {new () => T} ctor
   * @returns {T}
   */
  function must(id, ctor) {
    const node = document.getElementById(id);
    if (!(node instanceof ctor)) throw new Error("Panel is missing element #" + id);
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
    retry: must("retry", HTMLButtonElement),
    retryBanner: must("retry-banner", HTMLElement),
  };


  /** @typedef {"chat" | "builder" | "debugger"} Mode */
  /** @typedef {{ id: string, role: "user" | "assistant" | "system", text: string, reasoning?: string, diagrams?: Array<{ id: string, kind: string, title?: string, source: string }> }} ChatMessage */
  /** @typedef {{ id: string, path: string, additions?: number, deletions?: number, status: string, summary?: string }} Proposal */
  /** @typedef {{ path: string, startLine?: number, endLine?: number, kind?: string }} Attachment */
  /** @typedef {{ locale?: "zh" | "en", mode: Mode, busy: boolean, messages?: ChatMessage[], proposals?: Proposal[], attachments?: Attachment[], plan?: Array<{ text: string, status: string }>, turns?: Array<{ userMessageId?: string, status?: string, error?: string, inputTokens?: number, outputTokens?: number, elapsedMs?: number, modelWaitMs?: number, toolMs?: number, trace?: Array<any> }>, commandCheckpoints?: Array<{ id: string, files: string[], command: string }>, retryAvailable?: boolean, hint?: string }} PanelState */

  /** @type {{ mode: Mode, busy: boolean }} */
  let state = { mode: "chat", busy: false };
  /** @type {"zh" | "en"} */
  let locale = "zh";
  /** @param {string} zh @param {string} en */
  function tr(zh, en) { return locale === "en" ? en : zh; }

  function applyLocale() {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    el.stop.title = tr("停止", "Stop");
    el.reads.setAttribute("aria-label", tr("agent 最近读取的文件", "Files recently read by the agent"));
    el.messages.setAttribute("aria-label", tr("对话记录", "Conversation"));
    el.trajectory.setAttribute("aria-label", tr("会话轨迹", "Session trace"));
    el.trajectoryFilter.placeholder = tr("搜索轨迹…", "Search trace…");
    el.trajectoryFilter.setAttribute("aria-label", tr("搜索轨迹", "Search trace"));
    el.proposalsTitle.textContent = tr("待审提案", "Proposals");
    el.acceptAll.textContent = tr("全部接受", "Accept all");
    el.rejectAll.textContent = tr("全部拒绝", "Reject all");
    el.input.placeholder = tr("描述你的需求…（Ctrl+Enter 发送）", "Describe what you need… (Ctrl+Enter to send)");
    el.retry.textContent = tr("重试本轮", "Retry this turn");
    el.send.textContent = tr("发送", "Send");
    renderMode();
  }
  /** @type {HTMLElement | null} */
  let streamingNode = null;
  let streamingRaw = "";
  let streamRenderQueued = false;

  /** @param {unknown} message */
  function post(message) {
    vscode.postMessage(message);
  }

  /** @type {number | null} */
  let retryTimer = null;
  let retryDeadline = 0;

  function hideRetryBanner() {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    el.retryBanner.classList.add("hidden");
    el.retryBanner.textContent = "";
  }

  /** @param {boolean} available */
  function setRetryAvailable(available) {
    el.retry.classList.toggle("hidden", !available);
    el.retry.disabled = !available || state.busy;
  }

  /** @param {{ attempt?: number, max?: number, delayMs?: number, reason?: string, status?: string }} params */
  function showRetry(params) {
    const status = String(params.status || "");
    if (status === "done") {
      hideRetryBanner();
      return;
    }
    if (status === "starting") {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      el.retryBanner.classList.remove("hidden");
      el.retryBanner.textContent = tr("模型连接恢复中，正在重试…", "Reconnecting to the model…");
      return;
    }
    if (status !== "waiting") return;
    hideRetryBanner();
    const delay = Math.max(0, Number(params.delayMs || 0));
    const attempt = Number(params.attempt || 0);
    const max = Number(params.max || 0);
    const reason = String(params.reason || "");
    retryDeadline = Date.now() + delay;
    el.retryBanner.classList.remove("hidden");
    const tick = () => {
      const left = Math.max(0, retryDeadline - Date.now());
      const seconds = Math.ceil(left / 1000);
      el.retryBanner.textContent =
        tr("模型连接失败", "Model connection failed") + `, ${seconds}s ` + tr("后重试", "until retry") +
        (attempt && max ? ` (${attempt}/${max})` : "") +
        (reason ? ` · ${reason.slice(0, 80)}` : "");
      if (left <= 0 && retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
        el.retryBanner.textContent = tr("模型连接恢复中，正在重试…", "Reconnecting to the model…");
      }
    };
    tick();
    retryTimer = setInterval(tick, 250);
  }

  el.retry.addEventListener("click", () => {
    el.retry.classList.add("hidden");
    post({ type: "retry" });
  });

  function clearStreaming() {
    streamingNode = null;
    streamingRaw = "";
    streamRenderQueued = false;
  }

  function scheduleStreamRender() {
    if (streamRenderQueued || !streamingNode) return;
    streamRenderQueued = true;
    requestAnimationFrame(() => {
      streamRenderQueued = false;
      if (!streamingNode) return;
      streamingNode.innerHTML = renderMarkdown(streamingRaw);
      el.messages.scrollTop = el.messages.scrollHeight;
    });
  }

  /**
   * Screen-reader announcement (visible to assistive technology only; hidden visually).
   *
   * Why this exists: the message area is an aria-live region, and during streaming every chunk
   * could trigger an announcement, which is very noisy. So during streaming, aria-busy tells AT
   * to "hold off", and the result is announced once at the end.
   */
  /** @param {string} text */
  function announce(text) {
    // Setting the same text consecutively does not re-announce it: clear first, then write on the next tick
    el.srStatus.textContent = "";
    setTimeout(() => {
      el.srStatus.textContent = text;
    }, 30);
  }

  /** Mark the message area busy during streaming — affects announcement timing only, not visual rendering */
  /** @param {boolean} busy */
  function setMessagesBusy(busy) {
    el.messages.setAttribute("aria-busy", busy ? "true" : "false");
  }

  /** Command-level checkpoint card: changed files + one-click undo */
  /** @param {{ id?: string, files?: string[], command?: string }} item */
  function renderCommandCheckpoint(item) {
    const id = String(item.id || "");
    if (!id) return;
    if (el.messages.querySelector(`[data-checkpoint-id="${id}"]`)) return;

    const card = document.createElement("div");
    card.className = "msg command-checkpoint";
    card.dataset.checkpointId = id;

    const head = document.createElement("div");
    head.className = "cc-head";
    const title = document.createElement("span");
    const files = Array.isArray(item.files) ? item.files : [];
    title.textContent = tr(`命令修改了 ${files.length} 个文件`, `${files.length} file(s) changed by the command`);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cc-restore";
    button.textContent = tr("撤销本次修改", "Undo this change");
    head.append(title, button);

    const command = document.createElement("div");
    command.className = "cc-command";
    command.textContent = String(item.command || "");

    const details = document.createElement("details");
    details.className = "cc-files";
    const summary = document.createElement("summary");
    summary.textContent = tr("查看变更文件", "View changed files");
    const list = document.createElement("ul");
    for (const file of files.slice(0, 100)) {
      const li = document.createElement("li");
      li.textContent = file;
      list.appendChild(li);
    }
    if (files.length > 100) {
      const more = document.createElement("li");
      more.textContent = tr(`…还有 ${files.length - 100} 个`, `…and ${files.length - 100} more`);
      list.appendChild(more);
    }
    details.append(summary, list);
    card.append(head, command, details);
    el.messages.appendChild(card);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  /** @param {string} id @param {number} files */
  function markCommandRestored(id, files) {
    const card = el.messages.querySelector(`[data-checkpoint-id="${id}"]`);
    if (!(card instanceof HTMLElement)) return;
    card.classList.add("restored");
    const button = card.querySelector(".cc-restore");
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
      button.textContent = tr("已恢复", "Restored");
    }
    const title = card.querySelector(".cc-head span");
    if (title) title.textContent = tr(`已恢复 ${files} 个文件`, `Restored ${files} file(s)`);
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
    if (role === "assistant") {
      node.classList.add("markdown");
      node.innerHTML = renderMarkdown(text);
    } else {
      node.textContent = text;
    }
    if (id) node.dataset.messageId = id;
    el.messages.appendChild(node);
    el.messages.scrollTop = el.messages.scrollHeight;
    return node;
  }

  /**
   * Subagent card (aggregated by id).
   *
   * Shaped after production-grade agents: a collapsible "subagent" block whose title is the task and
   * whose body lists the tools it called, with a stats and conclusion line added when it finishes.
   * Expanded by default (users want to see the process); collapsible after completion.
   */
  /** @type {any} */
  const win = window;

  /** @param {string} text */
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const LANG_ALIASES = /** @type {Record<string, string>} */ ({
    py: "python",
    python: "python",
    cpp: "cpp",
    "c++": "cpp",
    cxx: "cpp",
    cc: "cpp",
    c: "c",
    cs: "csharp",
    "c#": "csharp",
    js: "javascript",
    javascript: "javascript",
    ts: "typescript",
    typescript: "typescript",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    bash: "bash",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    json: "json",
    html: "xml",
    xml: "xml",
    css: "css",
    sql: "sql",
    go: "go",
    rust: "rust",
    rs: "rust",
    java: "java",
    kotlin: "kotlin",
    swift: "swift",
    php: "php",
    ruby: "ruby",
  });

  /** @param {string} raw */
  function normalizeLang(raw) {
    const key = raw.trim().toLowerCase();
    return LANG_ALIASES[key] || key || "text";
  }

  /**
   * Inline Markdown: escape first, then handle code, links, bold, italics, and strikethrough.
   * @param {string} text
   */
  function renderInline(text) {
    /** @type {string[]} */
    const codes = [];
    let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `@@BEE_CODE_${codes.length - 1}@@`;
    });
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
    );
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    html = html.replace(/@@BEE_CODE_(\d+)@@/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
    return html;
  }

  /** @param {string} code @param {string} lang */
  function renderCodeBlock(code, lang) {
    const language = normalizeLang(lang);
    let body = escapeHtml(code);
    const highlighter = win.hljs;
    if (highlighter && language !== "text" && highlighter.getLanguage(language)) {
      try {
        body = highlighter.highlight(code, { language }).value;
      } catch {
        body = escapeHtml(code);
      }
    }
    return (
      '<div class="code-block">' +
      `<div class="code-head"><span class="code-lang">${escapeHtml(language)}</span>` +
      '<button type="button" class="code-copy">Copy</button></div>' +
      `<pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre>` +
      "</div>"
    );
  }

  /** @param {string} line */
  function tableCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }

  /**
   * Lightweight Markdown rendering (no full parser, to avoid raw HTML injection).
   * @param {string} text
   */
  function renderMarkdown(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    /** @type {string[]} */
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i] ?? "";

      const fence = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
      if (fence) {
        const marker = (fence[1] || "```")[0];
        const lang = fence[2] || "";
        const code = [];
        i += 1;
        while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i] || "")) {
          code.push(lines[i] || "");
          i += 1;
        }
        if (i < lines.length) i += 1;
        out.push(renderCodeBlock(code.join("\n"), lang));
        continue;
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
        out.push("<hr />");
        i += 1;
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = (heading[1] || "#").length;
        out.push(`<h${level}>${renderInline(heading[2] || "")}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i] || "")) {
          quote.push((lines[i] || "").replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] || "")) {
          items.push((lines[i] || "").replace(/^\s*[-*+]\s+/, ""));
          i += 1;
        }
        out.push("<ul>" + items.map((item) => `<li>${renderInline(item)}</li>`).join("") + "</ul>");
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] || "")) {
          items.push((lines[i] || "").replace(/^\s*\d+[.)]\s+/, ""));
          i += 1;
        }
        out.push("<ol>" + items.map((item) => `<li>${renderInline(item)}</li>`).join("") + "</ol>");
        continue;
      }

      if (
        line.includes("|") &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1] || "")
      ) {
        const head = tableCells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && (lines[i] || "").includes("|") && (lines[i] || "").trim()) {
          rows.push(tableCells(lines[i] || ""));
          i += 1;
        }
        const headHtml = "<tr>" + head.map((cell) => `<th>${renderInline(cell)}</th>`).join("") + "</tr>";
        const bodyHtml = rows
          .map((row) => "<tr>" + row.map((cell) => `<td>${renderInline(cell)}</td>`).join("") + "</tr>")
          .join("");
        out.push(`<table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>`);
        continue;
      }

      const para = [line];
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (
          !next.trim() ||
          /^\s*(```+|~~~+)/.test(next) ||
          /^\s*(?:#{1,6})\s+/.test(next) ||
          /^\s*>/.test(next) ||
          /^\s*[-*+]\s+/.test(next) ||
          /^\s*\d+[.)]\s+/.test(next) ||
          /^\s*(?:---|\*\*\*|___)\s*$/.test(next)
        ) {
          break;
        }
        para.push(next);
        i += 1;
      }
      out.push(`<p>${renderInline(para.join("\n")).replace(/\n/g, "<br />")}</p>`);
    }

    return out.join("\n");
  }

  el.messages.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const restore = target.closest(".cc-restore");
    if (restore instanceof HTMLButtonElement) {
      const card = restore.closest(".command-checkpoint");
      if (card instanceof HTMLElement && card.dataset.checkpointId) {
        restore.disabled = true;
        restore.textContent = tr("撤销中…", "Undoing…");
        post({ type: "restoreCommand", id: card.dataset.checkpointId });
      }
      return;
    }
    const button = target.closest(".code-copy");
    if (!(button instanceof HTMLButtonElement)) return;
    const block = button.closest(".code-block");
    const code = block ? block.querySelector("code") : null;
    if (!code) return;
    const text = code.textContent || "";
    void navigator.clipboard.writeText(text).then(
      () => {
        button.textContent = tr("已复制", "Copied");
        setTimeout(() => {
          button.textContent = tr("复制", "Copy");
        }, 1200);
      },
      () => {
        button.textContent = tr("复制失败", "Copy failed");
      },
    );
  });

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
    taskNode.textContent = task || tr("子代理任务", "Subagent task");

    const chip = document.createElement("span");
    chip.className = "subagent-chip running";
    chip.textContent = tr("探索中", "Exploring");

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
      announce("Subagent started: " + (task || "exploring code"));
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
      entry.chip.textContent = error ? tr("失败", "Failed") : tr("完成", "Done");
      entry.details.open = !error;

      const steps = typeof msg.steps === "number" ? msg.steps : 0;
      const toolCalls = typeof msg.toolCalls === "number" ? msg.toolCalls : 0;
      entry.stats.textContent = error
        ? "Failed: " + error
        : "Done · " + steps + " steps · " + toolCalls + " tool calls";

      const findings = typeof msg.findings === "string" ? msg.findings : "";
      if (findings) {
        entry.findings.textContent = findings;
        entry.findings.hidden = false;
        entry.result.hidden = false;
      } else if (!error) {
        entry.findings.hidden = true;
        entry.result.hidden = false;
      }
      announce(error ? "Subagent failed: " + error : "Subagent finished in " + steps + " steps");
      el.messages.scrollTop = el.messages.scrollHeight;
    }
  }
  /** Mode is chosen entirely by intent analysis: this only updates the badge and input hint */
  function renderMode() {
    const label = state.mode === "builder" ? "Builder" : state.mode === "debugger" ? "Debugger" : "Chat";
    el.modeBadge.textContent = label;
    el.modeBadge.title = tr("模式由意图分析自动选择", "Mode selected automatically from intent");
    el.input.placeholder =
      state.mode === "builder"
        ? "Describe the change to implement… (Ctrl+Enter to send)"
        : state.mode === "debugger"
          ? "Describe the error or unexpected behavior… (Ctrl+Enter to send)"
          : "Tell me what you want to do (the mode is chosen automatically)… (Ctrl+Enter to send)";
  }

  /** Chips for files the agent has read (one per path; re-reads update the line range and flash) */
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
      // Keep only the 8 most recent so they do not fill an entire row
      while (readChips.size > 8) {
        const oldest = readChips.keys().next().value;
        const node = readChips.get(oldest);
        if (node) node.remove();
        readChips.delete(oldest);
      }
    }
    chip.textContent = start && end ? `${name}:${start}-${end}` : name;
    chip.title = start && end ? `${path}, lines ${start}-${end} (click to open)` : `${path} (click to open)`;
    chip.dataset.path = path;
    if (start) chip.dataset.start = String(start);
    else delete chip.dataset.start;
    if (end) chip.dataset.end = String(end);
    else delete chip.dataset.end;
    chip.setAttribute("aria-label", `Open ${path}${start && end ? `, lines ${start} to ${end}` : ""}`);

    // Retrigger the animation: remove the class, then force a reflow
    chip.classList.remove("flash");
    void chip.offsetWidth;
    chip.classList.add("flash");
    setTimeout(() => chip.classList.remove("flash"), 1_200);
  }

  /** Per-turn trace card: collapsed by default; outer summary, inner steps, and full content (three levels) */
  /** @param {{ inputTokens?: number, outputTokens?: number, elapsedMs?: number, modelWaitMs?: number, toolMs?: number }} turn */
  function formatUsage(turn) {
    const tokens = (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0);
    const seconds = (turn.elapsedMs ?? 0) / 1000;
    const modelSeconds = (turn.modelWaitMs ?? 0) / 1000;
    const toolSeconds = (turn.toolMs ?? 0) / 1000;
    const parts = [];
    if (tokens > 0) parts.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`);
    if (seconds > 0) parts.push(`${seconds.toFixed(1)}s`);
    if (modelSeconds > 0) parts.push(`Model ${modelSeconds.toFixed(1)}s`);
    if (toolSeconds > 0) parts.push(`Tool ${toolSeconds.toFixed(1)}s`);
    return parts.join(" · ");
  }

  /** @param {any} step */
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
    let label = tr("步骤", "Step");
    if (type === "reasoning") label = tr(`思考 · 第 ${step.round ?? 1} 次`, `Reasoning · call ${step.round ?? 1}`);
    else if (type === "tool") label = tr(`工具 · ${step.name ?? "?"}${step.status ? ` · ${step.status}` : ""}`, `Tool · ${step.name ?? "?"}${step.status ? ` · ${step.status}` : ""}`);
    else if (type === "diagram") label = tr(`图 · ${step.title || step.name || "mermaid"}`, `Diagram · ${step.title || step.name || "mermaid"}`);
    else if (type === "error") label = tr("错误", "Error");
    summary.textContent = `${label}${preview ? ` · ${preview}` : ""}`;

    const short = document.createElement("pre");
    short.className = "trace-preview";
    short.textContent = (summaryText || text || detail || args || tr("（无内容）", "(empty)")).slice(0, 800);
    body.appendChild(short);

    const fullText = [summaryText, args, text, detail].filter(Boolean).join("\n\n");
    if (fullText.length > 800) {
      const full = document.createElement("details");
      full.className = "trace-full";
      const fullSummary = document.createElement("summary");
      fullSummary.textContent = tr("查看完整内容", "View full content");
      const pre = document.createElement("pre");
      pre.className = "trace-full-body";
      pre.textContent = fullText;
      full.append(fullSummary, pre);
      body.appendChild(full);
    }

    details.append(summary, body);
    return details;
  }

  /** @param {any} turn */
  function renderTraceCard(turn) {
    if (!turn) return;
    const card = document.createElement("details");
    card.className = "trace-card" + (turn.status === "error" ? " trace-error-card" : "");
    const summary = document.createElement("summary");
    summary.className = "trace-summary";
    const usage = formatUsage(turn);
    summary.textContent = `${turn.status === "error" ? tr("任务失败", "Task failed") : tr("任务已完成", "Task completed")}${usage ? ` · ${usage}` : ""}`;
    const body = document.createElement("div");
    body.className = "trace-body";
    const steps = Array.isArray(turn.trace) ? turn.trace : [];
    if (steps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "trace-empty";
      empty.textContent = tr("本轮没有工具调用或思考记录。", "No tool calls or reasoning in this turn.");
      body.appendChild(empty);
    }
    for (const step of steps) body.appendChild(traceStepNode(step));
    if (turn.error) {
      const error = document.createElement("div");
      error.className = "trace-error";
      error.textContent = `${tr("错误", "Error")}: ${turn.error}`;
      body.appendChild(error);
      if (usage) {
        const usageNode = document.createElement("div");
        usageNode.className = "trace-usage";
        usageNode.textContent = usage;
        body.appendChild(usageNode);
      }
    }
    card.append(summary, body);
    el.messages.appendChild(card);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  /** ── Mermaid: lazy-loaded only when a diagram appears (opening a history session / a new diagram this turn) ── */
  const SCRIPT_NONCE = document.currentScript && document.currentScript.nonce ? document.currentScript.nonce : "";
  /** @type {any} */
  /** @type {Promise<any> | null} */
  let mermaidPromise = null;
  let diagramSeq = 0;

  function getMermaid() {
    if (win.mermaid) return Promise.resolve(win.mermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise((resolve, reject) => {
      const uri = document.body.dataset.mermaidUri;
      if (!uri) {
        reject(new Error(tr("缺少 Mermaid 资源", "Missing Mermaid asset")));
        return;
      }
      const script = document.createElement("script");
      script.src = uri;
      if (SCRIPT_NONCE) script.nonce = SCRIPT_NONCE;
      script.onload = () => {
        try {
          win.mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            htmlLabels: false,
            theme: "dark",
            flowchart: { htmlLabels: false, useMaxWidth: true },
          });
          resolve(win.mermaid);
        } catch (err) {
          reject(err);
        }
      };
      script.onerror = () => reject(new Error(tr("Mermaid 加载失败", "Failed to load Mermaid")));
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
    title.textContent = diagram.title || tr(`${diagram.kind || "diagram"} 图`, `${diagram.kind || "diagram"} diagram`);
    const kind = document.createElement("span");
    kind.className = "diagram-kind";
    kind.textContent = diagram.kind || "mermaid";
    head.append(title, kind);
    const body = document.createElement("div");
    body.className = "diagram-body";
    body.textContent = tr("正在加载渲染器…", "Loading renderer…");
    card.append(head, body);
    el.messages.appendChild(card);
    el.messages.scrollTop = el.messages.scrollHeight;

    const seq = ++diagramSeq;
    const source = diagram.source;
    getMermaid()
      .then((/** @type {any} */ mermaid) => mermaid.render(`bee-diagram-${seq}`, source))
      .then((/** @type {any} */ result) => {
        if (!card.isConnected) return;
        body.textContent = "";
        body.innerHTML = result && result.svg ? result.svg : "";
      })
      .catch((/** @type {any} */ err) => {
        if (!card.isConnected) return;
        body.textContent = "";
        const note = document.createElement("div");
        note.className = "diagram-error";
        note.textContent = tr("渲染失败：", "Render failed: ") + (err instanceof Error ? err.message : String(err));
        const pre = document.createElement("pre");
        pre.className = "diagram-source";
        pre.textContent = source;
        body.append(note, pre);
      });
  }

  /** Reasoning content: split by "model call number" (display only, not added to context, but persisted with the message) */
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
      summary.textContent = key > 1 ? `Reasoning · call ${key}` : tr("思考过程", "Reasoning");
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
      appendReasoningBlock(tr("思考过程", "Reasoning"), reasoning);
      return;
    }
    if (!Array.isArray(reasoning)) return;
    for (const segment of reasoning) {
      const text = typeof segment?.text === "string" ? segment.text : "";
      const round = typeof segment?.round === "number" ? segment.round : 1;
      appendReasoningBlock(round > 1 ? `Reasoning · call ${round}` : tr("思考过程", "Reasoning"), text);
    }
  }

  /** Right-side session trace: one entry per turn by intent; click to jump to the matching message */
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
    label.textContent = intent || tr("（未记录意图）", "(no intent recorded)");
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

  /** Trace search: filter by intent text (case-insensitive) */
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
   * Plan checklist: reuse the same node when update_plan is called repeatedly within a turn.
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
      title.textContent = tr("计划", "Plan");
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
   * Proposal cards: one per file, three actions (view diff / accept / reject).
   * Nothing on disk changes before acceptance — that is the "preview first, apply later" model.
   * @param {Proposal[]} items
   */
  function renderProposals(items) {
    el.proposals.classList.toggle("hidden", items.length === 0);
    el.proposalsTitle.textContent = tr("待审提案（" + items.length + " 个文件）", "Proposals (" + items.length + " file(s))");
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
      stat.textContent = stale ? tr("已失效", "Stale") : "+" + (item.additions || 0) + " −" + (item.deletions || 0);

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
      view.textContent = tr("查看改动", "View changes");
      view.addEventListener("click", () => post({ type: "proposal.diff", id: item.id }));

      actions.appendChild(view);

      // A stale proposal cannot be accepted (its content no longer matches the latest file); it can only be viewed or discarded
      if (!stale) {
        const accept = document.createElement("button");
        accept.className = "primary";
        accept.textContent = tr("接受", "Accept");
        accept.addEventListener("click", () => post({ type: "accept", ids: [item.id] }));
        actions.appendChild(accept);
      }

      const reject = document.createElement("button");
      reject.textContent = stale ? tr("丢弃", "Discard") : tr("拒绝", "Reject");
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
        locale = next.locale === "en" ? "en" : "zh";
        applyLocale();
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
            continue;   // The error is already shown in the trace card; avoid a duplicate bubble
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
        for (const checkpoint of next.commandCheckpoints || []) renderCommandCheckpoint(checkpoint);
        planNode = null;
        readChips.clear();
        el.reads.textContent = "";
        if (next.plan && next.plan.length > 0) renderPlan(next.plan);
        renderMode();
        renderBusy();
        setRetryAvailable(Boolean(next.retryAvailable));
        hideRetryBanner();
        renderAttachments(next.attachments || []);
        renderProposals(next.proposals || []);
        el.hint.textContent = next.hint || "";
        break;
      }
      case "locale": {
        locale = msg.locale === "en" ? "en" : "zh";
        applyLocale();
        break;
      }
      case "status": {
        if (!msg.busy) hideRetryBanner();
        // Lightweight status: never re-render the message list (otherwise the streaming reply would be cleared)
        state.mode = /** @type {Mode} */ (msg.mode);
        state.busy = Boolean(msg.busy);
        if (!state.busy) setMessagesBusy(false);   // Safety net: always clear busy when the turn ends
        renderMode();
        renderBusy();
        el.hint.textContent = String(msg.hint ?? "");
        break;
      }
      case "message": {
        hideRetryBanner();
        const message = /** @type {ChatMessage} */ (msg.message);
        if (message.role === "assistant" && streamingNode) {
          // Wrap-up: the full text from the shell is authoritative; overwrite the accumulated stream instead of appending
          streamingNode.innerHTML = renderMarkdown(message.text);
          clearStreaming();
          setMessagesBusy(false);   // Streaming finished: it is safe to announce now
          announce("Assistant reply complete: " + message.text.length + " characters");
          break;
        }
        if (message.role === "user") clearStreaming();
        if (message.reasoning) appendPersistedReasoning(message.reasoning);
        if (message.text) addMessage(message.role, message.text, undefined, message.id);
        for (const diagram of message.diagrams || []) renderDiagramCard(diagram);
        if (message.role === "system") announce("System message: " + message.text);
        break;
      }
      case "delta": {
        hideRetryBanner();
        const text = String(msg.text ?? "");
        // Body started: collapse the reasoning blocks automatically (users can still expand them to review)
        collapseLiveReasoning();
        if (!streamingNode) {
          streamingNode = addMessage("assistant", "");
          setMessagesBusy(true);   // Streaming started: do not auto-announce yet
          announce("Assistant started responding");
        }
        streamingRaw += text;
        scheduleStreamRender();
        break;
      }


      case "attachments": {
        renderAttachments(/** @type {Attachment[]} */ (msg.items) || []);
        break;
      }
      case "proposals": {
        const items = /** @type {Proposal[]} */ (msg.items) || [];
        renderProposals(items);
        if (items.length > 0) announce("Proposals awaiting review: " + items.length);
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
      case "retryAvailable": {
        setRetryAvailable(Boolean(msg.available));
        break;
      }
      case "retry": {
        showRetry(/** @type {{ attempt?: number, max?: number, delayMs?: number, reason?: string, status?: string }} */ (msg));
        break;
      }
      case "plan": {
        renderPlan(/** @type {Array<{ text?: unknown, status?: unknown }>} */ (msg.steps));
        break;
      }
      case "commandCheckpoint": {
        renderCommandCheckpoint(/** @type {{ id?: string, files?: string[], command?: string }} */ (msg.item));
        break;
      }
      case "commandCheckpointRestored": {
        markCommandRestored(String(msg.id ?? ""), Number(msg.files ?? 0));
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
