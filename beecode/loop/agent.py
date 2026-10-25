"""Agent loop（M2）：工具调用循环。

流程：
    用户输入 → 模型（流式）→ 有 tool_calls？
        有  → 逐个执行（超时/异常都变成 tool 消息回灌）→ 继续
        没有 → 结束

四类守卫（这是"别提前收工 / 别死循环"的关键）：
  1. **空响应**：没有任何文本和工具调用 → 催一次，仍空则报错
  2. **只说不做**：builder/debugger 模式下模型只输出"我将…"却不调工具 → 催一次
  3. **重复调用**：同一工具 + 同一参数连续出现 → 拦截并警告，超过阈值终止
  4. **步数/预算**：max_steps 与输出 token 预算

工具失败的语义：**失败不是崩溃，而是 observation**。错误会作为 tool 消息回灌给模型，
同时用 `ui.tool(error)` 展示给用户——双方都看得见，模型据此改策略。
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import random
import uuid
from collections import Counter, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ..llm import (
    ChatDelta,
    ModelCapabilityError,
    ModelError,
    ReasoningReplayRequired,
    OpenAIClient,
    ToolCall,
    estimate_tokens,
    remember,
    resolve_vision,
)
from ..prompts import system_prompt
from ..router import Intent, classify
from ..session import Session, has_image_parts, strip_image_parts
from ..shell import ShellClient
from ..tools import Tool, ToolContext, build_tools, tool_schemas

Notify = Callable[[str, dict[str, Any]], None]
Propose = Callable[[str, str, str], Awaitable[str]]

#: 子代理的固定前缀：只读、给结论与引用、不复述代码
#: 模型请求在"还没产生任何输出"时的安全重试策略
MODEL_RETRY_MAX_ATTEMPTS = 6
MODEL_RETRY_INITIAL_S = 0.5
MODEL_RETRY_MAX_S = 10.0
RETRYABLE_MODEL_CODES = frozenset({"RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"})


class StreamInterrupted(Exception):
    """模型流在已经产生部分输出后断开；保留部分内容，由上层决定是否续写。"""

    def __init__(self, message: str, text: str, reasoning: str, calls: list[ToolCall]) -> None:
        super().__init__(message)
        self.text = text
        self.reasoning = reasoning
        self.calls = calls


PARALLEL_READONLY = frozenset({
    "read_file",
    "list_files",
    "search_code",
    "file_outline",
    "find_symbol",
    "find_references",
    "get_diagnostics",
})

_SUBAGENT_PREFIX = (
    "You are a read-only exploration subagent in a sandboxed tool environment. "
    "Use only read-only tools (read/search/symbols/diagnostics); you cannot edit files or spawn subagents. "
    "Answer with a conclusion first, then evidence (`path:line` references). Do not paste large code blocks; "
    "if you cannot find something, say so explicitly instead of inventing it."
)



@dataclass(slots=True)
class TurnConfig:
    max_steps: int = 12
    tool_timeout_s: float = 60.0
    #: 命令执行 / 派生子代理这类长工具的超时（秒）
    long_tool_timeout_s: float = 600.0
    #: 同一工具+参数最多执行几次（超过就拦截）
    repeat_limit: int = 3
    #: 允许的"催促"次数（空响应 / 只说不做 / 提前收工）
    nudge_limit: int = 2
    #: 模型上下文窗口（token）；轮内压缩按它的 ratio 触发
    context_window_tokens: int = 32_768
    #: 超过"窗口 × ratio"就开始压缩
    compact_ratio: float = 0.7
    #: 最近几条工具结果保留原文（更旧的替换成摘要）
    keep_raw_tool_results: int = 3
    #: 大任务放宽后的步数上限
    large_task_steps: int = 24
    #: 单轮 token 预算
    max_turn_tokens: int = 200_000
    #: 主 agent 单次模型响应超时（秒）：工具执行时间不计入
    max_turn_seconds: float = 600.0
    #: 大任务的主 agent 单次模型响应超时（按意图 scale 切换）
    large_task_seconds: float = 1_800.0
    #: 首 token 超时 / 流式空闲超时
    first_token_seconds: float = 60.0
    idle_seconds: float = 45.0
    #: 一次 assistant 消息里最多执行多少个工具调用
    max_tool_calls_per_batch: int = 8


@dataclass(slots=True)
class TurnStats:
    steps: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    proposals: int = 0
    model_wait_ms: int = 0
    tool_ms: int = 0


class AgentLoop:
    def __init__(
        self,
        notify: Notify,
        shell: ShellClient,
        *,
        config: TurnConfig | None = None,
        propose: Propose | None = None,
        client_factory: Callable[[Session], OpenAIClient] | None = None,
        log: Callable[[str], None] | None = None,
        role: str = "main",
        spawn_enabled: bool = True,
        spawn_config: dict[str, Any] | None = None,
        spawn_api_key: str | None = None,
        spawn_max_steps: int = 8,
    ) -> None:
        self._notify = notify
        self._shell = shell
        self._config = config or TurnConfig()
        self._propose = propose
        self._client_factory = client_factory or _default_client
        self._log = log or (lambda _msg: None)
        self._role = role
        self._spawn_enabled = spawn_enabled and role == "main"
        self._spawn_config = dict(spawn_config or {})
        self._spawn_api_key = spawn_api_key
        self._spawn_max_steps = max(1, min(int(spawn_max_steps or 8), 12))
        # 子代理没有 propose_edit，也没有 spawn_subagent（不允许无限嵌套）
        self._tools: dict[str, Tool] = build_tools(role, allow_spawn=self._spawn_enabled)
        self._schemas = tool_schemas(self._tools)
        #: token 估算校准系数（用服务端 usage 反推，EMA 平滑）
        self._calibration = 1.0
        #: 本轮已做过"观察摘要"的消息（按对象 id 记，避免往协议消息里加字段）
        self._digested: set[int] = set()
        self._compact_notice_added = False
        self._l3_used = False
        #: 本轮的当前计划（只由模型 update_plan 修改；内核不推断完成度）
        self._plan: list[dict[str, str]] | None = None
        #: 本轮生成的图（挂到 assistant 消息上，参与摘要/历史）
        self._diagrams: list[dict[str, Any]] = []
        #: 是否把思考内容回传给服务端（auto 模式下被"缺 reasoning_content"拒绝时自动打开）
        self._replay_reasoning = False
        #: 主 agent 单次模型响应预算（按 scale 动态设置；工具执行不计入）
        self._turn_time_budget = self._config.max_turn_seconds
        #: 80% 预算预警是否已经发过
        self._budget_warned = False
        #: 本轮是否已经因"计划未完成"催过一次（避免死循环）
        self._plan_nudged = False
        #: assistant 消息 → 思考内容（按对象 id 记，便于稍后补上 replay 字段）
        self._reasoning_by_msg: dict[int, str] = {}

    async def run_turn(
        self,
        session: Session,
        *,
        text: str,
        attachments: list[dict[str, Any]],
        history: list[dict[str, str]],
        summary: str | None,
        system_override: str | None = None,
        focus: dict[str, Any] | None = None,
        plan: list[dict[str, str]] | None = None,
    ) -> TurnStats:
        started_at = asyncio.get_running_loop().time()
        # —— 视觉能力：显式设置 > 服务端反馈（缓存） > 乐观尝试 ——
        base_url = str(session.model_config.get("baseUrl") or "")
        model_name = str(session.model_config.get("model") or "")
        resolved = resolve_vision(model_name, session.model_config.get("supportsVision"), base_url)  # type: ignore[arg-type]
        vision = True if resolved is None else resolved
        self._log(
            f"视觉输入：{'开' if vision else '关'}"
            f"（{model_name}；来源：{session.model_config.get('supportsVision') or 'auto'}"
            f"{'，已缓存' if resolved is not None else '，未知→先试'}）"
        )

        # 统一会话记忆：模式只影响"这轮怎么干"，不影响历史。
        # 每一轮都先做意图分析（用 chat 模式的结构化调用），再据此选模式与守卫策略。
        client = self._client_factory(session)
        intent: Intent | None = None
        effective_mode = str(session.mode)
        reused = False
        if system_override is None:
            previous = session.last_intent
            try:
                intent = await classify(client, text, history, log=self._log, previous=previous)
            except Exception as exc:  # noqa: BLE001 - 分类器不该拖垮整轮
                self._log(f"意图识别异常：{exc}")
                intent = Intent("chat", "small", False, f"意图识别异常，按 Chat 处理（{exc}）", "", degraded=True)

            # 是否"同一意图"完全交给模型判断，不用正则猜"继续/好/ok"
            if previous and intent.continues_previous:
                saved = previous
                intent = Intent(
                    mode=str(saved.get("mode") or "chat"),
                    scale=str(saved.get("scale") or "small"),
                    needs_proposal=bool(saved.get("needs_proposal")),
                    reason=f"延续上一轮意图（模型判定）",
                    intent=str(saved.get("intent") or intent.intent),
                    usage=intent.usage,
                    degraded=intent.degraded,
                    continues_previous=True,
                )
                reused = True
                self._log("意图沿用上一轮（模型判定为同一意图）")
            else:
                self._log("意图已更新（模型判定为新意图）")

            session.last_intent = {
                "mode": intent.mode,
                "scale": intent.scale,
                "needs_proposal": intent.needs_proposal,
                "intent": intent.intent,
                "reason": intent.reason,
                "degraded": intent.degraded,
            }
            effective_mode = intent.mode
            self._notify(
                "ui.intent",
                {
                    "sessionId": session.id,
                    "mode": effective_mode,
                    "intent": intent.intent or text[:120],
                    "reason": intent.reason,
                    "scale": intent.scale,
                    "needsProposal": intent.needs_proposal,
                    "degraded": intent.degraded,
                    "reused": reused,
                },
            )
            self._log(
                f"意图：{effective_mode}（{intent.reason}，规模 {intent.scale}，"
                f"需要提案 {intent.needs_proposal}{'，降级' if intent.degraded else ''}）"
            )
            if intent.needs_proposal:
                try:
                    checkpoint = await self._shell.checkpoint(
                        label=f"turn: {(intent.intent or text)[:40]}"
                    )
                    if checkpoint:
                        self._log(f"自动检查点：{checkpoint[:8]}")
                except Exception as exc:  # noqa: BLE001 - 快照失败不该阻断任务
                    self._log(f"自动检查点失败：{exc}")
        messages = session.build_request_messages(
            system_override or system_prompt(effective_mode),
            history=history,
            summary=summary,
            user_text=text,
            attachments=attachments,
            vision=vision,
        )
        # 光标位置作为一条 system 提示：告诉模型"先看这里，不够再搜"
        if focus:
            path = str(focus.get("path") or "")
            line = focus.get("line")
            start = focus.get("startLine")
            end = focus.get("endLine")
            symbol = focus.get("symbol")
            note = f"The user cursor is at {path}:{line}"
            if start and end:
                note += f"（已附上第 {start}-{end} 行"
                note += f"，函数 {symbol}）" if symbol else "）"
            messages.append(
                {
                    "role": "system",
                    "content": note + " Prioritize the attached context; use search_code / read_file only if more information is needed.",
                }
            )

        ctx = ToolContext(
            shell=self._shell,
            propose=self._propose or _no_propose,
            observed=session.observed_files,
            log=self._log,
            long_tool_timeout_s=self._config.long_tool_timeout_s,
            spawn=(lambda task, steps: self._spawn(task, steps, session)) if self._spawn_enabled else None,
            plan=(lambda steps: self._emit_plan(session, steps)),
            diagram=(lambda payload: self._emit_diagram(session, payload)),
        )

        self._digested.clear()
        self._compact_notice_added = False
        self._l3_used = False
        self._plan = None
        self._diagrams = []
        self._reasoning_by_msg.clear()
        self._budget_warned = False
        self._plan_nudged = False
        replay_setting = str(session.model_config.get("reasoningReplay") or "auto").lower()
        self._replay_reasoning = replay_setting == "always"
        max_steps = self._config.max_steps
        time_budget = self._config.max_turn_seconds
        if intent is not None and intent.scale == "large":
            max_steps = max(max_steps, self._config.large_task_steps)
            time_budget = self._config.large_task_seconds
        self._turn_time_budget = time_budget
        budget_hit: str | None = None
        forced_end = False

        # 跨轮延续：把上一轮未完成的计划作为 system 注入
        if plan:
            lines = []
            for index, step in enumerate(plan[:12], start=1):
                text = str(step.get("text") or "").strip()
                if not text:
                    continue
                status = str(step.get("status") or "pending")
                mark = "✓" if status == "done" else ("▶" if status == "doing" else "○")
                lines.append(f"{index}. {mark} {text}")
            if lines:
                messages.append(
                    {
                        "role": "system",
                        "content": "Plan left by the previous turn (not fully completed):\n" + "\n".join(lines)
                        + "\nContinue the unfinished steps; if the plan no longer applies, rewrite it with update_plan.",
                    }
                )

        # 延续上一轮时，把完整意图（目标/规模/模式/是否提案）也告诉主模型
        if reused and intent is not None:
            messages.append(
                {
                    "role": "system",
                    "content": (
                        f"The user is continuing the previous task: {intent.intent or text[:120]}.\n"
                        f"- Scale: {intent.scale}\n"
                        f"- Mode: {intent.mode}\n"
                        f"- Needs a proposal: {'yes' if intent.needs_proposal else 'no'}\n"
                        "Continue from here; do not restart."
                    ),
                }
            )

        # 大任务且需要产出：预置一份计划骨架，模型可以直接沿用/改写
        if (
            intent is not None
            and intent.needs_proposal
            and intent.scale == "large"
            and not plan
            and effective_mode != "chat"
        ):
            template = [
                {"text": "Read relevant files and confirm the change scope", "status": "doing"},
                {"text": "Implement the change (propose_edit)", "status": "pending"},
                {"text": "Run tests / build verification", "status": "pending"},
                {"text": "Summarize changes and remaining work", "status": "pending"},
            ]
            self._emit_plan(session, template)
            messages.append(
                {
                    "role": "system",
                    "content": "A plan skeleton was seeded (read → edit → test → summary). If it does not fit, rewrite it with update_plan; "
                    "update each step as you complete it, and mark the final summary step done before finishing.",
                }
            )

        stats = TurnStats()
        if intent is not None and intent.usage:
            stats.input_tokens += int(intent.usage.get("inputTokens") or 0)
            stats.output_tokens += int(intent.usage.get("outputTokens") or 0)
        repeat: Counter[str] = Counter()
        recent_results: deque[str] = deque(maxlen=3)
        nudges = 0
        # builder/debugger 默认要产出提案；auto 模式下完全由分类器决定
        wants_edit = intent.needs_proposal if intent is not None else effective_mode in ("builder", "debugger")

        # 大任务：在用户消息后追加"先制定计划"的指令（模型仍可自行判断要不要用）
        if intent is not None and intent.should_plan and effective_mode != "chat":
            messages.append(
                {
                    "role": "system",
                    "content": (
                        "This is a larger task. Before starting, call update_plan with 3-6 concrete steps, "
                        "update status after each step, and make each step name a file or action. "
                        "Mark the final summary step done before finishing."
                    ),
                }
            )
        final_text = ""
        interruptions = 0

        async def stream_model(**kwargs: Any):
            """调用模型；中途断流时保留部分输出并让模型续写一次。"""
            nonlocal interruptions
            try:
                return await self._stream_with_deadline(
                    client, messages, session, stats, **kwargs
                )
            except StreamInterrupted as exc:
                if interruptions >= 1:
                    raise ModelError(
                        "The model connection was interrupted twice mid-output; partial content was kept. Check the network and retry."
                    ) from exc
                interruptions += 1
                self._log(f"模型输出中断，保留部分内容：{exc}")
                self._emit(
                    "ui.tool",
                    {
                        "sessionId": session.id,
                        "name": "guard",
                        "status": "error",
                        "summary": "模型输出中断，已保留部分内容",
                    },
                )
                self._notify(
                    "log",
                    {"level": "warn", "msg": "模型连接在输出中途中断；已保留部分内容，正在尝试续写。"},
                )
                if exc.text.strip():
                    messages.append({"role": "assistant", "content": exc.text})
                messages.append(
                    {
                        "role": "system",
                        "content": (
                            "The previous model output was only partially delivered before the connection dropped; the partial content was kept. "
                            "Do not repeat any tool calls that already ran; continue from the available content. "
                            "If you cannot safely continue, say that the user should retry."
                        ),
                    }
                )
                return None

        self._emit("ui.tool", {"sessionId": session.id, "name": "model", "status": "start"})
        try:
            while stats.steps < max_steps:
                stats.steps += 1
                streamed = await stream_model(round_index=stats.steps)
                if streamed is None:
                    continue
                answer, calls, usage, reasoning = streamed
                self._emit_usage(session, stats, started_at)
                warning = self._budget_warning(stats, started_at)
                if warning and not self._budget_warned:
                    self._budget_warned = True
                    messages.append({"role": "system", "content": warning})
                    self._log(warning)
                    self._notify("log", {"level": "warn", "msg": warning})
                budget_hit = self._budget_reason(stats, started_at)
                if budget_hit:
                    break
                if not calls:
                    nudged = self._maybe_nudge(answer, session, nudges)
                    if nudged is not None:
                        nudges += 1
                        messages.append(nudged)
                        continue
                    final_text = answer
                    break

                assistant_msg = _assistant_tool_message(answer, calls)
                self._attach_reasoning(assistant_msg, reasoning)
                messages.append(assistant_msg)

                max_batch = max(1, self._config.max_tool_calls_per_batch)
                if len(calls) > max_batch:
                    for extra in calls[max_batch:]:
                        messages.append(
                            _tool_message(
                                extra,
                                {
                                    "error": f"This batch had more than {max_batch} tool calls; this one was skipped. Split the work into smaller batches.",
                                    "kind": "batch_limit",
                                },
                            )
                        )
                    calls = calls[:max_batch]

                def call_key(call: ToolCall) -> str:
                    return f"{call.name}:{_canonical(call.arguments)}"

                parallel = (
                    len(calls) > 1
                    and all(call.name in PARALLEL_READONLY for call in calls)
                    and len({call_key(call) for call in calls}) == len(calls)
                    and all(repeat[call_key(call)] + 1 < self._config.repeat_limit for call in calls)
                )

                if parallel:
                    for call in calls:
                        repeat[call_key(call)] += 1
                    results = await asyncio.gather(
                        *(self._execute(ctx, call, session, stats) for call in calls),
                        return_exceptions=True,
                    )
                    for call, raw in zip(calls, results):
                        if isinstance(raw, (asyncio.CancelledError, ModelError)):
                            raise raw
                        result = (
                            raw
                            if isinstance(raw, dict)
                            else {"error": f"Tool concurrency failed: {type(raw).__name__}: {raw}", "kind": "error"}
                        )
                        self._record_tool_result(session, call, result, stats, recent_results, messages)
                    continue

                for call in calls:
                    key = call_key(call)
                    repeat[key] += 1

                    if repeat[key] > self._config.repeat_limit:
                        self._emit_tool(session, call, "error", "Duplicate call blocked")
                        raise ModelError(
                            f"Duplicate call detected: {call.name} used identical arguments {repeat[key]} times; the turn was stopped. "
                            "Change approach (use another tool or narrow the scope) and retry."
                        )
                    if repeat[key] == self._config.repeat_limit:
                        warning = (
                            f"You called {call.name} with identical arguments {repeat[key]} times; the result will not change. "
                            "Use a different approach (wider/narrower scope, another tool) or summarize what you have."
                        )
                        self._emit_tool(session, call, "error", "Duplicate call skipped")
                        ctx.log(warning)
                        messages.append(_tool_message(call, {"error": warning, "kind": "repeat"}))
                        continue

                    result = await self._execute(ctx, call, session, stats)
                    self._record_tool_result(session, call, result, stats, recent_results, messages)

            else:
                forced_end = True
                final_text = await self._finish_max_steps(messages, client, session, stats)
            if budget_hit:
                forced_end = True
                final_text = await self._finish_with_notice(
                    messages,
                    client,
                    session,
                    stats,
                    f"The turn budget is exhausted ({budget_hit}). Do not call more tools; summarize what is done, what remains, and the recommended next step.",
                )

            # 提前收工检测：用户要求改代码，但整轮没有产出任何提案
            if wants_edit and stats.proposals == 0 and nudges < self._config.nudge_limit and not forced_end:
                nudges += 1
                self._emit("ui.tool", {
                    "sessionId": session.id, "name": "guard", "status": "error",
                    "summary": "No file change was submitted; asking the model to continue",
                })
                messages.append({
                    "role": "user",
                    "content": "You have not submitted any file change. If code must change, use edit_file for a targeted edit or propose_edit for a complete file; "
                               "if no change is needed, explain why.",
                })
                streamed = await stream_model(round_index=stats.steps)
                if streamed is None:
                    final_text = ""
                    raise ModelError("The model stream was interrupted while finishing; check the network and retry.")
                answer, calls, _usage, reasoning = streamed
                if calls:
                    assistant_msg = _assistant_tool_message(answer, calls)
                    self._attach_reasoning(assistant_msg, reasoning)
                    messages.append(assistant_msg)
                    for call in calls:
                        result = await self._execute(ctx, call, session, stats)
                        stats.tool_calls += 1
                        if call.name in ("propose_edit", "edit_file") and result.get("ok"):
                            stats.proposals += 1
                        messages.append(_tool_message(call, result))
                    streamed = await stream_model(round_index=stats.steps)
                    if streamed is None:
                        raise ModelError("The model stream was interrupted while finishing; check the network and retry.")
                    answer, _calls, _usage, _reasoning = streamed
                final_text = answer
        finally:
            self._emit("ui.tool", {"sessionId": session.id, "name": "model", "status": "end"})

        session.add_user(text, attachments)
        session.add_assistant(final_text, self._diagrams)
        self._notify(
            "ui.usage",
            {
                "sessionId": session.id,
                "inputTokens": stats.input_tokens or _estimate_input(messages),
                "outputTokens": stats.output_tokens or estimate_tokens(final_text),
                "elapsedMs": int((asyncio.get_running_loop().time() - started_at) * 1000),
                "modelWaitMs": stats.model_wait_ms,
                "toolMs": stats.tool_ms,
            },
        )
        return stats

    # ───────────────────────── 模型调用 ─────────────────────────

    # ───────────────────────── 轮内压缩 ─────────────────────────

    def _estimate_messages_tokens(self, messages: list[dict[str, Any]], *, calibrate: bool = True) -> int:
        raw = 0
        for message in messages:
            content = message.get("content")
            if isinstance(content, str):
                raw += estimate_tokens(content)
            elif isinstance(content, list):
                raw += sum(estimate_tokens(str(part)) for part in content)
            for call in message.get("tool_calls") or []:
                raw += estimate_tokens(str((call.get("function") or {}).get("arguments") or ""))
        return int(raw * (self._calibration if calibrate else 1.0))

    async def _compact(
        self,
        client: OpenAIClient,
        messages: list[dict[str, Any]],
        session: Session,
        *,
        force: bool = False,
    ) -> None:
        """轮内压缩：工具结果摘要 → 丢更早的交换 → 模型摘要（兜底）。"""
        budget = max(2_000, int(self._config.context_window_tokens * self._config.compact_ratio))
        if force:
            # 服务端已明确报 context overflow：按半预算强制压缩，不再相信估算值
            budget = max(2_000, int(budget * 0.5))
        if not force and self._estimate_messages_tokens(messages) <= budget:
            return

        # ① 旧工具结果 → 观察摘要（保留最近 keep_raw_tool_results 条原文）
        keep = max(0, self._config.keep_raw_tool_results)
        positions = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
        candidates = positions[:-keep] if keep and len(positions) > keep else ([] if keep else positions)
        replaced = 0
        for index in candidates:
            if not force and self._estimate_messages_tokens(messages) <= budget:
                break
            message = messages[index]
            if id(message) in self._digested:
                continue
            raw = str(message.get("content") or "")
            message["content"] = json.dumps(_digest_tool_content(raw), ensure_ascii=False)
            self._digested.add(id(message))
            replaced += 1
        if replaced:
            self._compact_log(session, f"把 {replaced} 条早期工具结果折叠为摘要")

        # ①b 仍超预算：连"最近几条"也折叠（原文可随时重新读取）
        if self._estimate_messages_tokens(messages) > budget:
            extra = 0
            for index in positions:
                if not force and self._estimate_messages_tokens(messages) <= budget:
                    break
                message = messages[index]
                if id(message) in self._digested:
                    continue
                message["content"] = json.dumps(_digest_tool_content(str(message.get("content") or "")), ensure_ascii=False)
                self._digested.add(id(message))
                extra += 1
            if extra:
                self._compact_log(session, f"又折叠了 {extra} 条工具结果")

        if not force and self._estimate_messages_tokens(messages) <= budget:
            return

        # ② 丢掉更早的 assistant+tool 交换（保留当前用户消息及之后）
        dropped = _drop_oldest_exchanges(messages)
        if dropped:
            self._compact_log(session, f"移除了 {dropped} 条更早的对话片段")

        if not force and self._estimate_messages_tokens(messages) <= budget:
            return

        # ③ 兜底：让模型把最早的一半过程压成一段（一轮最多一次）
        if force:
            self._l3_used = False
        if not self._l3_used:
            self._l3_used = True
            await self._l3_summarize(client, messages, session, budget)

    async def _l3_summarize(
        self,
        client: OpenAIClient,
        messages: list[dict[str, Any]],
        session: Session,
        budget: int,
    ) -> None:
        last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
        if last_user <= 2:
            return
        chunk = messages[1:last_user]
        text = "\n".join(
            f"{m.get('role')}: {_content_text(m)[:800]}" for m in chunk if _content_text(m).strip()
        )[:12_000]
        if not text.strip():
            return
        summary = ""
        for attempt in range(2):
            try:
                summary, _usage = await client.complete(
                    [
                        {
                            "role": "system",
                            "content": "Summarize the agent execution below in at most 200 words. Keep conclusions, files touched, and failure causes. Output only the summary.",
                        },
                        {"role": "user", "content": text},
                    ],
                    timeout=45.0,
                )
                break
            except ModelError as exc:
                retryable = getattr(exc, "code", "UNKNOWN") in RETRYABLE_MODEL_CODES
                if retryable and attempt == 0:
                    self._log(f"轮内摘要失败，1s 后重试：{exc}")
                    await asyncio.sleep(1.0)
                    continue
                # 自动压缩失败不拖垮主任务：保留现有历史继续
                self._log(f"轮内摘要失败：{exc}")
                return
        if not summary.strip():
            return
        job_lines = _running_job_lines(chunk)
        job_note = ("\n[Running background jobs]\n" + "\n".join(job_lines)) if job_lines else ""
        note = {"role": "system", "content": f"[In-turn summary] {summary.strip()[:600]}{job_note}"}
        messages[1:last_user] = [note]
        self._compact_log(session, f"模型摘要替代了 {len(chunk)} 条早期消息")

    def _compact_log(self, session: Session, detail: str) -> None:
        self._log(f"轮内压缩：{detail}")
        self._notify("log", {"level": "warn", "msg": f"上下文接近上限，已压缩：{detail}"})

    async def _stream(
        self,
        client: OpenAIClient,
        messages: list[dict[str, Any]],
        session: Session,
        stats: TurnStats,
        *,
        allow_tools: bool = True,
        round_index: int = 1,
    ) -> tuple[str, list[ToolCall], dict[str, int] | None, str]:
        """一次模型调用。

        视觉能力不靠模型名猜：服务端如果明确拒绝图片，就剥掉图片重试一次，
        并把"该模型不支持图片"记进缓存（后续轮次直接不带图）。
        思考内容默认不回传；只有服务端明确要求（或配置 always）才补上。
        """
        base_url = str(session.model_config.get("baseUrl") or "")
        model_name = str(session.model_config.get("model") or "")
        await self._compact(client, messages, session)
        model_started = asyncio.get_running_loop().time()
        try:
            result = await self._stream_once(
                client,
                messages,
                session,
                stats,
                allow_tools=allow_tools,
                round_index=round_index,
                deadline_start=model_started,
            )
            if has_image_parts(messages):
                remember(model_name, base_url, True)
            return result
        except ModelCapabilityError as exc:
            if not has_image_parts(messages):
                raise
            strip_image_parts(messages)
            remember(model_name, base_url, False)
            self._log(f"模型拒绝图片，省略后重试：{exc}")
            self._emit(
                "ui.tool",
                {
                    "sessionId": session.id,
                    "name": "guard",
                    "status": "error",
                    "summary": "模型不接受图片，已省略图片重试",
                },
            )
            self._notify(
                "log",
                {
                    "level": "warn",
                    "msg": "当前模型不接受图片：本轮已改为文字描述，后续不再发送图片。",
                },
            )
            return await self._stream_once(
                client,
                messages,
                session,
                stats,
                allow_tools=allow_tools,
                round_index=round_index,
                deadline_start=model_started,
            )
        except ReasoningReplayRequired as exc:
            if self._replay_reasoning or str(session.model_config.get("reasoningReplay") or "auto").lower() == "never":
                raise
            self._replay_reasoning = True
            self._enable_replay(messages)
            self._log(f"服务端要求回传思考内容，已补上并重试：{exc}")
            return await self._stream_once(
                client,
                messages,
                session,
                stats,
                allow_tools=allow_tools,
                deadline_start=model_started,
            )

    async def _stream_once(
        self,
        client: OpenAIClient,
        messages: list[dict[str, Any]],
        session: Session,
        stats: TurnStats,
        *,
        allow_tools: bool = True,
        round_index: int = 1,
        deadline_start: float | None = None,
    ) -> tuple[str, list[ToolCall], dict[str, int] | None, str]:
        started = deadline_start or asyncio.get_running_loop().time()
        attempt = 0
        had_retry = False
        context_compactions = 0

        def timeout_error(reason: str) -> ModelError:
            return ModelError(f"Main agent model timeout ({reason}); the turn was stopped.", code="TIMEOUT")

        while True:
            parts: list[str] = []
            reasoning_parts: list[str] = []
            calls: list[ToolCall] = []
            usage: dict[str, int] | None = None
            attempt_started = asyncio.get_running_loop().time()
            iterator = client.stream_chat(messages, tools=self._schemas if allow_tools else None)
            first = True
            retry_reason: str | None = None
            retry_after: float | None = None

            try:
                while True:
                    now = asyncio.get_running_loop().time()
                    model_left = self._turn_time_budget - (now - started)
                    if model_left <= 0:
                        raise timeout_error("response")
                    idle_budget = self._config.first_token_seconds if first else self._config.idle_seconds
                    model_bound = model_left <= idle_budget
                    wait = min(idle_budget, model_left)
                    try:
                        delta = await asyncio.wait_for(iterator.__anext__(), timeout=wait)
                    except StopAsyncIteration:
                        break
                    except asyncio.TimeoutError as exc:
                        now = asyncio.get_running_loop().time()
                        if model_bound or now - started >= self._turn_time_budget:
                            raise timeout_error("response") from exc
                        # 已经产生部分输出：不重放，交给上层保留/续写
                        if parts or reasoning_parts or calls:
                            raise StreamInterrupted(
                                "Model stream timed out mid-output",
                                "".join(parts),
                                "".join(reasoning_parts),
                                calls,
                            ) from exc
                        if attempt + 1 < MODEL_RETRY_MAX_ATTEMPTS:
                            retry_reason = "First-token timeout"
                            break
                        raise timeout_error("first token") from exc

                    first = False
                    if delta.usage:
                        usage = delta.usage
                    if delta.tool_calls:
                        calls.extend(delta.tool_calls)
                    if delta.text:
                        parts.append(delta.text)
                        self._emit("ui.delta", {"sessionId": session.id, "text": delta.text})
                    if delta.reasoning:
                        reasoning_parts.append(delta.reasoning)
                        self._emit(
                            "ui.reasoning",
                            {"sessionId": session.id, "text": delta.reasoning, "round": round_index},
                        )
            except ModelError as exc:
                if parts or reasoning_parts or calls:
                    # 已经吐出的内容不能丢弃，也不能自动重跑（否则工具可能重复执行）
                    raise StreamInterrupted(
                        str(exc), "".join(parts), "".join(reasoning_parts), calls
                    ) from exc
                code = getattr(exc, "code", "UNKNOWN")
                if code == "CONTEXT_OVERFLOW" and context_compactions < 1:
                    context_compactions += 1
                    self._log("服务端报告上下文溢出，强制压缩后重试")
                    self._l3_used = False
                    try:
                        await self._compact(client, messages, session, force=True)
                    except asyncio.CancelledError:
                        raise
                    except Exception as compact_exc:  # noqa: BLE001 - 压缩失败仍原样重试一次
                        self._log(f"强制压缩失败：{compact_exc}")
                    retry_reason = "Context overflow; forced compaction"
                    retry_after = None
                else:
                    if code not in RETRYABLE_MODEL_CODES:
                        raise
                    if attempt + 1 >= MODEL_RETRY_MAX_ATTEMPTS:
                        raise
                    retry_reason = str(exc)
                    retry_after = getattr(exc, "retry_after", None)
            except asyncio.CancelledError:
                raise
            finally:
                with contextlib.suppress(Exception):
                    aclose = getattr(iterator, "aclose", None)
                    if aclose is not None:
                        await aclose()
                if stats is not None:
                    stats.model_wait_ms += int((asyncio.get_running_loop().time() - attempt_started) * 1000)

            if retry_reason is None:
                break

            attempt += 1
            delay = (
                min(retry_after, MODEL_RETRY_MAX_S)
                if retry_after
                else min(MODEL_RETRY_INITIAL_S * (2 ** (attempt - 1)), MODEL_RETRY_MAX_S)
            )
            delay *= 1.0 + random.uniform(-0.1, 0.1)
            remaining = self._turn_time_budget - (asyncio.get_running_loop().time() - started)
            if delay >= remaining:
                raise timeout_error("response")
            retry_msg = (
                f"模型请求失败（{retry_reason}），{delay:.1f}s 后重试 "
                f"({attempt + 1}/{MODEL_RETRY_MAX_ATTEMPTS})"
            )
            self._log(retry_msg)
            self._notify("log", {"level": "warn", "msg": retry_msg})
            had_retry = True
            self._notify(
                "ui.retry",
                {
                    "sessionId": session.id,
                    "attempt": attempt,
                    "max": MODEL_RETRY_MAX_ATTEMPTS - 1,
                    "delayMs": int(delay * 1000),
                    "reason": retry_reason,
                    "status": "waiting",
                },
            )
            await asyncio.sleep(max(0.0, delay))
            self._notify(
                "ui.retry",
                {
                    "sessionId": session.id,
                    "attempt": attempt,
                    "max": MODEL_RETRY_MAX_ATTEMPTS - 1,
                    "status": "starting",
                },
            )

        if usage:
            stats.input_tokens += int(usage.get("inputTokens") or 0)
            stats.output_tokens += int(usage.get("outputTokens") or 0)
            # 用服务端 usage 校准估算系数（EMA），让轮内压缩的预算更接近真实
            prompt_tokens = int(usage.get("inputTokens") or 0)
            estimated = self._estimate_messages_tokens(messages, calibrate=False)
            if prompt_tokens > 0 and estimated > 0:
                ratio = prompt_tokens / estimated
                self._calibration = min(2.0, max(0.5, self._calibration * 0.5 + ratio * 0.5))
        if had_retry:
            self._notify("ui.retry", {"sessionId": session.id, "status": "done"})
        return "".join(parts), calls, usage, "".join(reasoning_parts)

    # ───────────────────────── 工具执行 ─────────────────────────

    def _record_tool_result(
        self,
        session: Session,
        call: ToolCall,
        result: dict[str, Any],
        stats: TurnStats,
        recent_results: deque[str],
        messages: list[dict[str, Any]],
    ) -> None:
        stats.tool_calls += 1
        if call.name in ("propose_edit", "edit_file") and result.get("ok"):
            stats.proposals += 1
        self._emit_read(session, call, result)

        digest = _digest(result)
        if digest in recent_results and len(recent_results) == recent_results.maxlen:
            warning = "Several tool results were identical; calling again cannot help. Change approach or summarize."
            self._emit_tool(session, call, "error", "Result unchanged")
            result = {"error": warning, "kind": "no_progress"}
        recent_results.append(digest)
        messages.append(_tool_message(call, result))

    async def _execute(
        self,
        ctx: ToolContext,
        call: ToolCall,
        session: Session,
        stats: TurnStats | None = None,
    ) -> dict[str, Any]:
        tool = self._tools.get(call.name)
        if tool is None:
            message = f"Unknown tool: {call.name} (available: {', '.join(self._tools)})"
            self._emit_tool(session, call, "error", message)
            return {"error": message, "kind": "unknown_tool"}

        try:
            args = json.loads(call.arguments or "{}")
            if not isinstance(args, dict):
                raise ValueError("参数必须是 JSON 对象")
        except (json.JSONDecodeError, ValueError) as exc:
            message = f"Failed to parse arguments: {exc}. Check that the JSON is valid."
            self._emit_tool(session, call, "error", "Invalid arguments")
            return {"error": message, "kind": "bad_arguments"}

        self._emit_tool(
            session,
            call,
            "start",
            _brief_args(args),
            args=_short(json.dumps(args, ensure_ascii=False), 1200),
        )
        timeout_s = (
            self._config.long_tool_timeout_s
            if call.name in ("run_command", "command_wait", "spawn_subagent")
            else self._config.tool_timeout_s
        )
        if call.name == "run_command":
            requested_ms = args.get("yield_ms") or args.get("timeout_ms")
            if isinstance(requested_ms, (int, float)) and requested_ms > 0:
                timeout_s = max(timeout_s, float(requested_ms) / 1000.0 + 30.0)
        elif call.name == "command_wait":
            requested_ms = args.get("yield_ms")
            if isinstance(requested_ms, (int, float)) and requested_ms > 0:
                timeout_s = max(timeout_s, float(requested_ms) / 1000.0 + 30.0)
        elif call.name == "spawn_subagent":
            # 子代理收尾/回传结论需要一点余量
            timeout_s += 30.0
        started = asyncio.get_running_loop().time()
        try:
            result = await asyncio.wait_for(
                tool.fn(ctx, args), timeout=timeout_s
            )
            elapsed = asyncio.get_running_loop().time() - started
            if stats is not None:
                stats.tool_ms += int(elapsed * 1000)
            brief = _brief_args(args)
            self._emit_tool(
                session,
                call,
                "end",
                f"{brief + ' · ' if brief else ''}{elapsed:.1f}s",
                detail=_short(json.dumps(result, ensure_ascii=False, default=str), 8000),
                duration_ms=int(elapsed * 1000),
            )
            return result
        except asyncio.TimeoutError:
            if stats is not None:
                stats.tool_ms += int((asyncio.get_running_loop().time() - started) * 1000)
            message = (
                f"Tool {call.name} timed out ({timeout_s:g}s). "
                "Narrow the scope or use another approach; do not retry with identical arguments."
            )
            self._emit_tool(session, call, "error", "Timed out")
            ctx.log(message)
            return {"error": message, "kind": "timeout"}
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 工具错误必须回灌给模型
            if stats is not None:
                stats.tool_ms += int((asyncio.get_running_loop().time() - started) * 1000)
            message = f"Tool {call.name} failed: {type(exc).__name__}: {exc}"
            self._emit_tool(session, call, "error", _short(str(exc)))
            ctx.log(message)
            return {"error": message, "kind": "error"}

    # ───────────────────────── 守卫 ─────────────────────────

    def _unfinished_plan_steps(self) -> list[tuple[int, dict[str, str]]]:
        """非最后一步里仍 pending/doing 的步骤（最后一步规定为总结）。"""
        if not self._plan or len(self._plan) <= 1:
            return []
        result: list[tuple[int, dict[str, str]]] = []
        for index, step in enumerate(self._plan[:-1], start=1):
            if str(step.get("status") or "pending") != "done":
                result.append((index, step))
        return result

    def _maybe_nudge(
        self,
        answer: str,
        session: Session,
        nudges: int,
    ) -> dict[str, Any] | None:
        """决定是否"催一下"。返回要追加的消息，或 None 表示可以结束。"""
        if nudges >= self._config.nudge_limit:
            return None

        if not answer.strip():
            self._emit("ui.tool", {
                "sessionId": session.id, "name": "guard", "status": "error",
                "summary": "模型返回空响应，要求重试",
            })
            return {"role": "user", "content": "You produced no output. Continue the task; if information is missing, ask explicitly."}

        # 计划未完成：非最后一步还有 pending/doing，就不要让它直接收尾
        if not self._plan_nudged and not answer.rstrip().endswith(("？", "?")):
            blockers = self._unfinished_plan_steps()
            if blockers:
                self._plan_nudged = True
                self._emit("ui.tool", {
                    "sessionId": session.id, "name": "guard", "status": "error",
                    "summary": f"计划还有 {len(blockers)} 步未完成",
                })
                listing = "\n".join(f"{index}. [{step.get('status')}] {step.get('text')}" for index, step in blockers)
                return {
                    "role": "user",
                    "content": (
                        f"Plan steps remain incomplete:\n{listing}\n"
                        "If these steps are already done, call update_plan and mark them done "
                        "(do not merely say \"done\" in prose); otherwise keep using tools. "
                        "If the plan no longer applies, rewrite it with update_plan."
                        "The final summary step may stay until the end, but mark it done afterwards with update_plan."
                    ),
                }

        return None

    async def _stream_with_deadline(
        self,
        client: OpenAIClient,
        messages: list[dict[str, Any]],
        session: Session,
        stats: TurnStats,
        *,
        allow_tools: bool = True,
        round_index: int = 1,
    ) -> tuple[str, list[ToolCall], dict[str, int] | None, str]:
        """模型响应计时入口。

        真正的首 token / 空闲 / 总响应 deadline 在 `_stream_once` 内，
        从上下文压缩之后开始计时；工具执行不在其中。
        """
        return await self._stream(
            client,
            messages,
            session,
            stats,
            allow_tools=allow_tools,
            round_index=round_index,
        )

    async def _finish_max_steps(
        self,
        messages: list[dict[str, Any]],
        client: OpenAIClient,
        session: Session,
        stats: TurnStats,
    ) -> str:
        """达到步数上限：要求模型基于已有信息收尾（不再给工具）。"""
        return await self._finish_with_notice(
            messages,
            client,
            session,
            stats,
            "The step limit was reached. Do not call more tools; conclude from the available information and state what remains and what to do next.",
        )

    async def _finish_with_notice(
        self,
        messages: list[dict[str, Any]],
        client: OpenAIClient,
        session: Session,
        stats: TurnStats,
        notice: str,
    ) -> str:
        # 硬截断前先存快照：避免"预算/步数用尽时改了一半"无法回退
        await self._checkpoint_before_cutoff(session, notice)

        self._emit(
            "ui.tool",
            {
                "sessionId": session.id,
                "name": "guard",
                "status": "error",
                "summary": notice[:60],
            },
        )
        messages.append({"role": "user", "content": notice})
        try:
            answer, _calls, _usage, _reasoning = await self._stream_with_deadline(
                client, messages, session, stats, allow_tools=False, round_index=stats.steps
            )
        except StreamInterrupted as exc:
            raise ModelError(f"模型在收尾阶段输出中断：{exc}") from exc
        return answer

    def _emit_usage(self, session: Session, stats: TurnStats, started_at: float) -> None:
        self._notify(
            "ui.usage",
            {
                "sessionId": session.id,
                "inputTokens": stats.input_tokens,
                "outputTokens": stats.output_tokens,
                "elapsedMs": int((asyncio.get_running_loop().time() - started_at) * 1000),
            },
        )

    def _attach_reasoning(self, message: dict[str, Any], reasoning: str) -> None:
        """记住 assistant 消息的思考内容；需要回传时才写进协议字段。"""
        if not reasoning:
            return
        self._reasoning_by_msg[id(message)] = reasoning
        if self._replay_reasoning:
            message["reasoning_content"] = reasoning

    def _enable_replay(self, messages: list[dict[str, Any]]) -> None:
        for message in messages:
            if message.get("role") != "assistant":
                continue
            reasoning = self._reasoning_by_msg.get(id(message))
            if reasoning:
                message["reasoning_content"] = reasoning

    async def _checkpoint_before_cutoff(self, session: Session, notice: str) -> None:
        if self._role != "main":
            return
        try:
            checkpoint = await self._shell.checkpoint(label=f"cutoff: {notice[:40]}")
            if checkpoint:
                self._log(f"硬截断前快照：{checkpoint[:8]}")
                self._notify(
                    "log",
                    {"level": "warn", "msg": f"已达到本轮上限，已自动创建检查点 {checkpoint[:8]}"},
                )
        except Exception as exc:  # noqa: BLE001 - 快照失败不该阻断收尾
            self._log(f"硬截断前快照失败：{exc}")

    def _budget_warning(self, stats: TurnStats, started_at: float) -> str | None:
        """到 80% token 预算时提前提醒模型收尾。"""
        del started_at
        used = stats.input_tokens + stats.output_tokens
        if used > self._config.max_turn_tokens * 0.8:
            return (
                f"About {used} tokens used (over 80% of the {self._config.max_turn_tokens} budget). "
                "Finish the key change and wrap up; skip unnecessary exploration."
            )
        return None

    def _budget_reason(self, stats: TurnStats, started_at: float) -> str | None:
        del started_at
        used = stats.input_tokens + stats.output_tokens
        if used > self._config.max_turn_tokens:
            return f"token {used} > {self._config.max_turn_tokens}"
        return None

    def _emit_read(self, session: Session, call: ToolCall, result: dict[str, Any]) -> None:
        """读文件类工具成功后广播位置：壳用它做编辑器高亮 / 文件 chips。"""
        if not result.get("ok", True) or result.get("error"):
            return
        path = result.get("path")
        if not isinstance(path, str) or not path:
            return
        params: dict[str, Any] = {"sessionId": session.id, "path": path, "tool": call.name}
        start = result.get("startLine")
        end = result.get("endLine")
        if isinstance(start, int) and isinstance(end, int):
            params["startLine"] = start
            params["endLine"] = end
        self._notify("ui.read", params)

    def _emit_diagram(self, session: Session, payload: dict[str, Any]) -> None:
        if len(self._diagrams) >= 3:
            raise RuntimeError("At most 3 diagrams per turn; merge or remove some")
        self._diagrams.append(payload)
        self._notify("ui.diagram", {"sessionId": session.id, "diagram": payload})

    def _emit_plan(self, session: Session, steps: list[dict[str, str]]) -> None:
        self._plan = steps
        self._notify("ui.plan", {"sessionId": session.id, "steps": steps})

    # ───────────────────────── 子代理 ─────────────────────────

    async def _spawn(self, task: str, max_steps: int, parent: Session) -> dict[str, Any]:
        """跑一个只读子代理，只把结论带回来。

        隔离点：
          - 独立 Session / 独立上下文（它读几十个文件也不会污染主对话）
          - 只读工具集（没有 propose_edit / edit_file / spawn_subagent）
          - 壳侧根据 `role: subagent` 收紧命令与写权限
          - 取消随父任务一起传播（同一个 asyncio 任务树）
        """
        # 子代理配置：用户显式指定的字段覆盖主代理，其余沿用
        child_config = dict(parent.model_config)
        for key, value in self._spawn_config.items():
            if value is not None and value != "":
                child_config[key] = value
        api_key = self._spawn_api_key or parent.api_key
        child = Session.create(f"sub_{uuid.uuid4().hex[:8]}", "chat", child_config, api_key)
        sub_id = child.id

        def child_notify(method: str, params: dict[str, Any]) -> None:
            """子代理的进度：只转发工具事件，文本不推流（避免刷屏）。"""
            if method != "ui.tool":
                return
            name = str(params.get("name") or "")
            if not name or name == "model":
                return
            self._notify(
                "ui.subagent",
                {
                    "sessionId": parent.id,
                    "id": sub_id,
                    "status": "tool",
                    "tool": {
                        "name": name,
                        "status": params.get("status"),
                        "summary": params.get("summary"),
                    },
                },
            )

        self._notify(
            "ui.subagent",
            {
                "sessionId": parent.id,
                "id": sub_id,
                "status": "start",
                "task": task,
                "maxSteps": min(max(1, max_steps), self._spawn_max_steps),
            },
        )

        child_loop = AgentLoop(
            child_notify,
            self._shell.with_role("subagent"),
            config=TurnConfig(
                max_steps=min(max(1, max_steps), self._spawn_max_steps),
                tool_timeout_s=self._config.tool_timeout_s,
                long_tool_timeout_s=self._config.long_tool_timeout_s,
                repeat_limit=self._config.repeat_limit,
                nudge_limit=1,
                context_window_tokens=self._config.context_window_tokens,
                max_turn_seconds=self._config.max_turn_seconds,
                large_task_seconds=self._config.large_task_seconds,
                first_token_seconds=self._config.first_token_seconds,
                idle_seconds=self._config.idle_seconds,
                max_tool_calls_per_batch=self._config.max_tool_calls_per_batch,
            ),
            propose=None,
            client_factory=self._client_factory,
            log=self._log,
            role="subagent",
        )
        self._log(f"subagent 开始：{task[:100]}")
        try:
            stats = await child_loop.run_turn(
                child,
                text=f"任务：{task}",
                attachments=[],
                history=[],
                summary=None,
                system_override=_SUBAGENT_PREFIX,
            )
        except asyncio.CancelledError:
            self._notify(
                "ui.subagent",
                {"sessionId": parent.id, "id": sub_id, "status": "end", "error": "已取消"},
            )
            raise
        except Exception as exc:  # noqa: BLE001 - 子代理失败不该拖垮主循环
            message = f"{type(exc).__name__}: {exc}"
            self._notify(
                "ui.subagent",
                {"sessionId": parent.id, "id": sub_id, "status": "end", "error": message[:500]},
            )
            self._log(f"subagent 失败：{message}")
            return {"ok": False, "error": message, "findings": "", "steps": 0, "toolCalls": 0}

        answer = ""
        for message in reversed(child.messages):
            if message.get("role") == "assistant" and isinstance(message.get("content"), str):
                answer = str(message["content"])
                break
        self._log(f"subagent 结束：steps={stats.steps} tools={stats.tool_calls}")
        findings = answer[:8000] if answer else "（子代理没有给出结论）"
        self._notify(
            "ui.subagent",
            {
                "sessionId": parent.id,
                "id": sub_id,
                "status": "end",
                "steps": stats.steps,
                "toolCalls": stats.tool_calls,
                "findings": findings[:2000],
            },
        )
        return {
            "ok": True,
            "findings": findings,
            "steps": stats.steps,
            "toolCalls": stats.tool_calls,
        }

    # ───────────────────────── 通知 ─────────────────────────

    def _emit(self, method: str, params: dict[str, Any]) -> None:
        self._notify(method, params)

    def _emit_tool(
        self,
        session: Session,
        call: ToolCall,
        status: str,
        summary: str | None = None,
        *,
        args: str | None = None,
        detail: str | None = None,
        duration_ms: int | None = None,
    ) -> None:
        params: dict[str, Any] = {"sessionId": session.id, "name": call.name, "status": status}
        if summary:
            params["summary"] = summary
        if args:
            params["args"] = args
        if detail:
            params["detail"] = detail
        if duration_ms is not None:
            params["durationMs"] = duration_ms
        self._emit("ui.tool", params)


# ───────────────────────── 工具函数 ─────────────────────────


def _default_client(session: Session) -> OpenAIClient:
    return OpenAIClient(
        base_url=str(session.model_config.get("baseUrl") or ""),
        model=str(session.model_config.get("model") or ""),
        api_key=session.api_key,
    )


async def _no_propose(_path: str, _content: str, _summary: str, **_kwargs: object) -> str:
    raise RuntimeError("No proposal channel is configured in this kernel")


def _assistant_tool_message(text: str, calls: list[ToolCall]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": text or None,
        "tool_calls": [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": call.arguments},
            }
            for call in calls
        ],
    }


def _tool_message(call: ToolCall, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": call.id,
        "content": json.dumps(result, ensure_ascii=False),
    }


def _canonical(arguments: str) -> str:
    try:
        value = json.loads(arguments or "{}")
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except json.JSONDecodeError:
        return arguments


def _digest(result: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps(result, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _brief_args(args: dict[str, Any]) -> str:
    kind = args.get("kind")
    if isinstance(kind, str) and kind in ("flowchart", "sequence", "class", "state", "er"):
        title = str(args.get("title") or "").strip()
        text = f"{kind}: {title}" if title else kind
        return text if len(text) <= 60 else text[:57] + "..."
    for key in ("path", "query", "command", "glob"):
        value = args.get(key)
        if isinstance(value, str) and value:
            return value if len(value) <= 60 else value[:57] + "..."
    return ""


def _short(text: str, limit: int = 80) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _estimate_input(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            total += sum(estimate_tokens(str(part)) for part in content)
    return total

def _content_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
    return ""


def _running_job_lines(messages: list[dict[str, Any]]) -> list[str]:
    """从当前上下文提取仍在运行的后台任务，压缩时不能把 jobId 丢掉。"""
    lines: list[str] = []
    seen: set[str] = set()
    for message in messages:
        if message.get("role") != "tool":
            continue
        try:
            data = json.loads(str(message.get("content") or ""))
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        job_id = data.get("jobId")
        if not job_id or data.get("status") != "running" or str(job_id) in seen:
            continue
        seen.add(str(job_id))
        lines.append(
            f"- {job_id} [{data.get('sandbox') or '?'}] running {int(data.get('elapsedMs') or 0)/1000:.0f}s"
            f"; {data.get('progress') or 'still running'}; poll with command_wait or stop with command_terminate"
        )
    return lines


def _digest_tool_content(raw: str) -> dict[str, Any]:
    """把一条工具结果压成"观察摘要"：留指针与关键指标，不留正文。"""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {"digest": True, "tool": "unknown", "note": "结果已省略", "preview": raw[:120]}
    if not isinstance(data, dict):
        return {"digest": True, "tool": "unknown", "note": "结果已省略"}

    if "findings" in data:
        # 子代理只回传最终结论；这是唯一不能丢的内容，完整保留
        return {
            "digest": True,
            "tool": "spawn_subagent",
            "ok": data.get("ok"),
            "steps": data.get("steps"),
            "toolCalls": data.get("toolCalls"),
            "findings": str(data.get("findings") or ""),
            **({"error": str(data["error"])} if data.get("error") else {}),
            "note": "子代理结论完整保留",
        }
    if data.get("tool") == "diagram" or ("kind" in data and "id" in data and "source" not in data):
        return {
            "digest": True,
            "tool": "diagram",
            "id": data.get("id"),
            "kind": data.get("kind"),
            "title": data.get("title"),
            "note": "图已渲染；完整源码在助手消息的 diagrams 字段里",
        }
    if data.get("proposalId") and "replacements" in data:
        return {
            "digest": True,
            "tool": "edit_file",
            "proposalId": data.get("proposalId"),
            "path": data.get("path"),
            "replacements": data.get("replacements"),
            "mode": data.get("mode"),
            "note": "局部编辑提案已登记",
        }
    if "exitCode" in data:
        if data.get("jobId"):
            # 后台任务的状态和 jobId 不能丢；旧轮询输出只留尾部
            tail = str(data.get("stdout") or data.get("stderr") or "")[-300:]
            return {
                "digest": True,
                "tool": "run_command",
                "jobId": data.get("jobId"),
                "status": data.get("status"),
                "exitCode": data.get("exitCode"),
                "ok": data.get("ok"),
                "elapsedMs": data.get("elapsedMs"),
                "outputAgeMs": data.get("outputAgeMs"),
                "progress": data.get("progress"),
                "noNewOutput": data.get("noNewOutput"),
                **({"lastOutput": tail} if tail.strip() else {}),
                "note": "后台任务状态保留；完整输出请用 command_wait",
            }
        return {
            "digest": True,
            "tool": "run_command",
            "exitCode": data.get("exitCode"),
            "ok": data.get("ok"),
            "note": "输出已省略（需要时重新运行）",
        }
    if "jobs" in data and isinstance(data.get("jobs"), list):
        jobs = []
        for item in data["jobs"][:8]:
            if not isinstance(item, dict):
                continue
            jobs.append(
                {
                    "jobId": item.get("jobId"),
                    "status": item.get("status"),
                    "elapsedMs": item.get("elapsedMs"),
                    "command": str(item.get("command") or "")[:120],
                }
            )
        return {"digest": True, "tool": "command_list", "jobs": jobs, "count": len(data["jobs"])}
    if "hits" in data:
        return {"digest": True, "tool": "search_code", "hits": len(data.get("hits") or []), "note": "命中内容已省略"}
    if "files" in data and "path" not in data:
        return {"digest": True, "tool": "list_files", "count": len(data.get("files") or [])}
    if "symbols" in data:
        return {"digest": True, "tool": "file_outline", "path": data.get("path"), "symbols": len(data.get("symbols") or [])}
    if data.get("path") and "lines" in data:
        return {"digest": True, "tool": "read_file", "path": data.get("path"), "lines": data.get("lines"), "note": "内容已省略"}
    if "locations" in data:
        return {"digest": True, "tool": "find_references", "count": len(data.get("locations") or [])}
    if "diagnostics" in data:
        return {"digest": True, "tool": "get_diagnostics", "counts": data.get("counts"), "note": "明细已省略"}
    preview = raw[:120]
    return {"digest": True, "tool": "tool", "note": "结果已省略", "preview": preview}


def _drop_oldest_exchanges(messages: list[dict[str, Any]]) -> int:
    """删掉最早的 assistant+tool_calls 及其工具回复（保留首条 system 与当前用户消息之后）。"""
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    if last_user <= 1:
        return 0
    dropped = 0
    index = 1
    while index < last_user:
        message = messages[index]
        if message.get("role") == "assistant" and message.get("tool_calls"):
            ids = {str(call.get("id")) for call in message["tool_calls"]}
            # 正在运行的后台 job 的 tool 结果不能丢：模型还要靠 jobId 轮询/终止
            running_job = False
            for tool_message in messages[index + 1 :]:
                if tool_message.get("role") != "tool" or str(tool_message.get("tool_call_id")) not in ids:
                    continue
                try:
                    data = json.loads(str(tool_message.get("content") or ""))
                except (json.JSONDecodeError, TypeError):
                    continue
                if isinstance(data, dict) and data.get("jobId") and data.get("status") == "running":
                    running_job = True
                    break
            if running_job:
                index += 1
                continue
            del messages[index]
            dropped += 1
            last_user -= 1
            while index < len(messages) and messages[index].get("role") == "tool" and str(messages[index].get("tool_call_id")) in ids:
                del messages[index]
                dropped += 1
                last_user -= 1
            continue
        index += 1
    return dropped

