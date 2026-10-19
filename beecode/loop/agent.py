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
import hashlib
import json
import re
import uuid
from collections import Counter, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ..llm import ChatDelta, ModelError, OpenAIClient, ToolCall, estimate_tokens
from ..llm.vision import supports_vision
from ..prompts import system_prompt
from ..router import Intent, classify
from ..session import Session
from ..shell import ShellClient
from ..tools import Tool, ToolContext, build_tools, tool_schemas

Notify = Callable[[str, dict[str, Any]], None]
Propose = Callable[[str, str, str], Awaitable[str]]

#: 子代理的固定前缀：只读、给结论与引用、不复述代码
_SUBAGENT_PREFIX = (
    "你是一个只读探索子代理，运行在沙箱化的工具环境中。"
    "只能用只读工具（读文件/搜索/符号/诊断）；不能修改文件，也不能再派生子代理。"
    "回答要求：先给结论，再给证据（`path:line` 引用）；不要复述大段代码；"
    "找不到就明确说找不到，不要编造。"
)

#: 模型"只说不做"的措辞特征（只在 builder/debugger 模式下用，且只催一次）
_PROMISE_PATTERN = re.compile(
    r"(我将|我会|接下来我|接下来会|马上|稍等|正在执行|开始执行|立刻|随后我|"
    r"Let me|I will|I'll|Now I|Next, I)",
    re.IGNORECASE,
)
#: 用户要求改代码的特征（用于判断"这轮应该产出提案"）
_EDIT_INTENT_PATTERN = re.compile(
    r"(修改|实现|修复|重构|添加|新增|删除|改成|改为|加上|替换|重写|优化|补全|"
    r"fix|implement|refactor|add|remove|rename|update)",
    re.IGNORECASE,
)


@dataclass(slots=True)
class TurnConfig:
    max_steps: int = 12
    tool_timeout_s: float = 60.0
    #: 同一工具+参数最多执行几次（超过就拦截）
    repeat_limit: int = 3
    #: 允许的"催促"次数（空响应 / 只说不做 / 提前收工）
    nudge_limit: int = 2


@dataclass(slots=True)
class TurnStats:
    steps: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    proposals: int = 0


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

    async def run_turn(
        self,
        session: Session,
        *,
        text: str,
        attachments: list[dict[str, Any]],
        history: list[dict[str, str]],
        summary: str | None,
        system_override: str | None = None,
    ) -> TurnStats:
        vision = supports_vision(
            str(session.model_config.get("model") or ""),
            session.model_config.get("supportsVision"),  # type: ignore[arg-type]
        )
        self._log(f"视觉模型：{'是' if vision else '否'}（{session.model_config.get('model', '')}）")

        # 统一会话记忆：模式只影响"这轮怎么干"，不影响历史。
        # auto 模式下先做意图/规模识别，再选提示词与守卫策略。
        requested_mode = str(session.mode)
        intent: Intent | None = None
        effective_mode = requested_mode
        if requested_mode == "auto":
            intent = classify(text, history)
            effective_mode = intent.mode
            self._notify(
                "ui.mode",
                {
                    "sessionId": session.id,
                    "mode": effective_mode,
                    "auto": True,
                    "reason": intent.reason,
                    "scale": intent.scale,
                },
            )
            self._log(f"auto 模式：{effective_mode}（{intent.reason}，规模 {intent.scale}）")

        messages = session.build_request_messages(
            system_override or system_prompt(effective_mode),
            history=history,
            summary=summary,
            user_text=text,
            attachments=attachments,
            vision=vision,
        )
        client = self._client_factory(session)
        ctx = ToolContext(
            shell=self._shell,
            propose=self._propose or _no_propose,
            log=self._log,
            spawn=(lambda task, steps: self._spawn(task, steps, session)) if self._spawn_enabled else None,
            plan=(lambda steps: self._emit_plan(session, steps)),
        )

        stats = TurnStats()
        repeat: Counter[str] = Counter()
        recent_results: deque[str] = deque(maxlen=3)
        nudges = 0
        wants_edit = effective_mode in ("builder", "debugger") and bool(_EDIT_INTENT_PATTERN.search(text))

        # 大任务：在用户消息后追加"先制定计划"的指令（模型仍可自行判断要不要用）
        if intent is not None and intent.should_plan and effective_mode != "chat":
            messages.append(
                {
                    "role": "system",
                    "content": (
                        "这是一项较大的任务。开始动手前先调用 update_plan 列出 3-6 个步骤，"
                        "之后每完成一步更新状态；步骤要具体到文件或动作。"
                    ),
                }
            )
        final_text = ""

        self._emit("ui.tool", {"sessionId": session.id, "name": "model", "status": "start"})
        try:
            while stats.steps < self._config.max_steps:
                stats.steps += 1
                answer, calls, usage = await self._stream_once(client, messages, session, stats)
                if not calls:
                    nudged = self._maybe_nudge(answer, session, effective_mode, nudges)
                    if nudged is not None:
                        nudges += 1
                        messages.append(nudged)
                        continue
                    final_text = answer
                    break

                messages.append(_assistant_tool_message(answer, calls))
                for call in calls:
                    key = f"{call.name}:{_canonical(call.arguments)}"
                    repeat[key] += 1

                    if repeat[key] > self._config.repeat_limit:
                        self._emit_tool(session, call, "error", "重复调用，已阻断")
                        raise ModelError(
                            f"检测到重复调用：{call.name} 连续 {repeat[key]} 次相同参数，已终止这一轮。"
                            "请调整策略（换个工具或缩小范围）后重试。"
                        )
                    if repeat[key] == self._config.repeat_limit:
                        warning = (
                            f"你已经用相同参数调用了 {call.name} {repeat[key]} 次，结果不会变。"
                            "请换一种方式（扩大/缩小范围、换工具），或直接总结当前信息。"
                        )
                        self._emit_tool(session, call, "error", "重复调用，已跳过")
                        ctx.log(warning)
                        messages.append(_tool_message(call, {"error": warning, "kind": "repeat"}))
                        continue

                    result = await self._execute(ctx, call, session)
                    stats.tool_calls += 1
                    if call.name == "propose_edit" and result.get("ok"):
                        stats.proposals += 1

                    digest = _digest(result)
                    if digest in recent_results and len(recent_results) == recent_results.maxlen:
                        warning = "连续多次工具结果完全相同，继续调用没有意义。请换策略或总结。"
                        self._emit_tool(session, call, "error", "结果无变化")
                        result = {"error": warning, "kind": "no_progress"}
                    recent_results.append(digest)
                    messages.append(_tool_message(call, result))

            else:
                final_text = await self._finish_max_steps(messages, client, session, stats)

            # 提前收工检测：用户要求改代码，但整轮没有产出任何提案
            if wants_edit and stats.proposals == 0 and nudges < self._config.nudge_limit:
                nudges += 1
                self._emit("ui.tool", {
                    "sessionId": session.id, "name": "guard", "status": "error",
                    "summary": "本轮没有提交任何文件修改，要求模型继续",
                })
                messages.append({
                    "role": "user",
                    "content": "你还没有提交任何文件修改。如果任务需要改代码，请调用 propose_edit 提交；"
                               "如果不需要改，请明确说明原因。",
                })
                answer, calls, _usage = await self._stream_once(client, messages, session, stats)
                if calls:
                    messages.append(_assistant_tool_message(answer, calls))
                    for call in calls:
                        result = await self._execute(ctx, call, session)
                        stats.tool_calls += 1
                        if call.name == "propose_edit" and result.get("ok"):
                            stats.proposals += 1
                        messages.append(_tool_message(call, result))
                    answer, _calls, _usage = await self._stream_once(client, messages, session, stats)
                final_text = answer
        finally:
            self._emit("ui.tool", {"sessionId": session.id, "name": "model", "status": "end"})

        session.add_user(text, attachments)
        session.add_assistant(final_text)
        self._notify(
            "ui.usage",
            {
                "sessionId": session.id,
                "inputTokens": stats.input_tokens or _estimate_input(messages),
                "outputTokens": stats.output_tokens or estimate_tokens(final_text),
            },
        )
        return stats

    # ───────────────────────── 模型调用 ─────────────────────────

    async def _stream_once(
        self,
        client: OpenAIClient,
        messages: list[dict[str, Any]],
        session: Session,
        stats: TurnStats,
    ) -> tuple[str, list[ToolCall], dict[str, int] | None]:
        parts: list[str] = []
        calls: list[ToolCall] = []
        usage: dict[str, int] | None = None

        async for delta in client.stream_chat(messages, tools=self._schemas):
            if delta.usage:
                usage = delta.usage
            if delta.tool_calls:
                calls.extend(delta.tool_calls)
            if delta.text:
                parts.append(delta.text)
                self._emit("ui.delta", {"sessionId": session.id, "text": delta.text})

        if usage:
            stats.input_tokens += int(usage.get("inputTokens") or 0)
            stats.output_tokens += int(usage.get("outputTokens") or 0)
        return "".join(parts), calls, usage

    # ───────────────────────── 工具执行 ─────────────────────────

    async def _execute(self, ctx: ToolContext, call: ToolCall, session: Session) -> dict[str, Any]:
        tool = self._tools.get(call.name)
        if tool is None:
            message = f"未知工具：{call.name}（可用：{', '.join(self._tools)}）"
            self._emit_tool(session, call, "error", message)
            return {"error": message, "kind": "unknown_tool"}

        try:
            args = json.loads(call.arguments or "{}")
            if not isinstance(args, dict):
                raise ValueError("参数必须是 JSON 对象")
        except (json.JSONDecodeError, ValueError) as exc:
            message = f"参数解析失败：{exc}。请检查 JSON 是否合法。"
            self._emit_tool(session, call, "error", "参数不合法")
            return {"error": message, "kind": "bad_arguments"}

        self._emit_tool(session, call, "start", _brief_args(args))
        started = asyncio.get_running_loop().time()
        try:
            result = await asyncio.wait_for(
                tool.fn(ctx, args), timeout=self._config.tool_timeout_s
            )
            elapsed = asyncio.get_running_loop().time() - started
            self._emit_tool(session, call, "end", f"{elapsed:.1f}s")
            return result
        except asyncio.TimeoutError:
            message = (
                f"工具 {call.name} 超时（{self._config.tool_timeout_s:g}s）。"
                "请缩小范围或换一种方式，不要用相同参数重试。"
            )
            self._emit_tool(session, call, "error", "超时")
            ctx.log(message)
            return {"error": message, "kind": "timeout"}
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 工具错误必须回灌给模型
            message = f"工具 {call.name} 失败：{type(exc).__name__}: {exc}"
            self._emit_tool(session, call, "error", _short(str(exc)))
            ctx.log(message)
            return {"error": message, "kind": "error"}

    # ───────────────────────── 守卫 ─────────────────────────

    def _maybe_nudge(
        self,
        answer: str,
        session: Session,
        effective_mode: str,
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
            return {"role": "user", "content": "你刚才没有输出任何内容。请继续完成任务；如果缺少信息，请明确问我。"}

        if effective_mode != "chat" and _PROMISE_PATTERN.search(answer) and not answer.rstrip().endswith(("？", "?")):
            self._emit("ui.tool", {
                "sessionId": session.id, "name": "guard", "status": "error",
                "summary": "模型只描述计划、未调用工具",
            })
            return {
                "role": "user",
                "content": "不要只描述计划。请立即调用工具执行；如果任务已经完成，请直接给出最终结论。",
            }
        return None

    async def _finish_max_steps(
        self,
        messages: list[dict[str, Any]],
        client: OpenAIClient,
        session: Session,
        stats: TurnStats,
    ) -> str:
        """达到步数上限：要求模型基于已有信息收尾（不再给工具）。"""
        self._emit("ui.tool", {
            "sessionId": session.id, "name": "guard", "status": "error",
            "summary": f"已达步数上限（{self._config.max_steps}）",
        })
        messages.append({
            "role": "user",
            "content": "已达到本轮步数上限。请不要再调用工具，基于已有信息给出结论、未完成部分与下一步建议。",
        })
        answer, _calls, _usage = await self._stream_once(client, messages, session, stats)
        return answer

    def _emit_plan(self, session: Session, steps: list[dict[str, str]]) -> None:
        self._notify("ui.plan", {"sessionId": session.id, "steps": steps})

    # ───────────────────────── 子代理 ─────────────────────────

    async def _spawn(self, task: str, max_steps: int, parent: Session) -> dict[str, Any]:
        """跑一个只读子代理，只把结论带回来。

        隔离点：
          - 独立 Session / 独立上下文（它读几十个文件也不会污染主对话）
          - 只读工具集（没有 propose_edit / spawn_subagent）
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
                repeat_limit=self._config.repeat_limit,
                nudge_limit=1,
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

    def _emit_tool(self, session: Session, call: ToolCall, status: str, summary: str | None = None) -> None:
        params: dict[str, Any] = {"sessionId": session.id, "name": call.name, "status": status}
        if summary:
            params["summary"] = summary
        self._emit("ui.tool", params)


# ───────────────────────── 工具函数 ─────────────────────────


def _default_client(session: Session) -> OpenAIClient:
    return OpenAIClient(
        base_url=str(session.model_config.get("baseUrl") or ""),
        model=str(session.model_config.get("model") or ""),
        api_key=session.api_key,
    )


async def _no_propose(_path: str, _content: str, _summary: str) -> str:
    raise RuntimeError("当前内核没有配置提案通道")


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
