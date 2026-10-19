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
from collections import Counter, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ..llm import ChatDelta, ModelError, OpenAIClient, ToolCall, estimate_tokens
from ..llm.vision import supports_vision
from ..prompts import system_prompt
from ..session import Session
from ..shell import ShellClient
from ..tools import Tool, ToolContext, build_tools, tool_schemas

Notify = Callable[[str, dict[str, Any]], None]
Propose = Callable[[str, str, str], Awaitable[str]]

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
    ) -> None:
        self._notify = notify
        self._shell = shell
        self._config = config or TurnConfig()
        self._propose = propose
        self._client_factory = client_factory or _default_client
        self._log = log or (lambda _msg: None)
        self._tools: dict[str, Tool] = build_tools()
        self._schemas = tool_schemas(self._tools)

    async def run_turn(
        self,
        session: Session,
        *,
        text: str,
        attachments: list[dict[str, Any]],
        history: list[dict[str, str]],
        summary: str | None,
    ) -> TurnStats:
        vision = supports_vision(
            str(session.model_config.get("model") or ""),
            session.model_config.get("supportsVision"),  # type: ignore[arg-type]
        )
        self._log(f"视觉模型：{'是' if vision else '否'}（{session.model_config.get('model', '')}）")

        messages = session.build_request_messages(
            system_prompt(session.mode),
            history=history,
            summary=summary,
            user_text=text,
            attachments=attachments,
            vision=vision,
        )
        client = self._client_factory(session)
        ctx = ToolContext(shell=self._shell, propose=self._propose or _no_propose, log=self._log)

        stats = TurnStats()
        repeat: Counter[str] = Counter()
        recent_results: deque[str] = deque(maxlen=3)
        nudges = 0
        wants_edit = session.mode in ("builder", "debugger") and bool(_EDIT_INTENT_PATTERN.search(text))
        final_text = ""

        self._emit("ui.tool", {"sessionId": session.id, "name": "model", "status": "start"})
        try:
            while stats.steps < self._config.max_steps:
                stats.steps += 1
                answer, calls, usage = await self._stream_once(client, messages, session, stats)
                if not calls:
                    nudged = self._maybe_nudge(answer, session, nudges)
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

        if session.mode != "chat" and _PROMISE_PATTERN.search(answer) and not answer.rstrip().endswith(("？", "?")):
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
