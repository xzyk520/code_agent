"""意图识别：**用主模型自己判断**，不靠关键词硬编码。

输出被约束成三类（chat / builder / debugger）。优先用 JSON Schema 强制结构化；
服务端不支持 `response_format` 时逐级降级（json_object → 纯文本 + 解析）。
模型给了三类之外的值 → 带着错误信息要求它改，连续两次仍不合法就退回 chat
（宁可答错也不让整轮对话失败）。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .llm.openai import ModelError, OpenAIClient

MODES = ("chat", "builder", "debugger")

INTENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "mode": {"type": "string", "enum": list(MODES)},
        "scale": {"type": "string", "enum": ["small", "large"]},
        "needs_proposal": {"type": "boolean"},
        "reason": {"type": "string"},
        "intent": {"type": "string"},
    },
    "required": ["mode", "scale", "needs_proposal", "reason", "intent"],
    "additionalProperties": False,
}

_SYSTEM = """你是 Bee Code 的意图分类器。只输出 JSON 对象，不要输出任何解释或 Markdown。

字段：
- mode: "chat" | "builder" | "debugger"
- scale: "small" | "large"
- needs_proposal: boolean（这一轮是否应该产出文件修改提案）
- reason: 一句话中文说明（为什么这么判）
- intent: 一句话概括"用户想达成什么"（用于后续总结，不要写实现细节）

判定规则：
- chat：解释代码、回答问题、讨论方案，不需要改动文件
- builder：新增/修改/重构/迁移代码，预期产出文件修改
- debugger：报错、异常、崩溃、行为不符预期的定位与修复
- builder 与 debugger **默认 needs_proposal=true**；只有用户明确表示"先讨论/不要改"时才 false
- scale=large：涉及多个文件、架构调整、迁移、需求描述很长；否则 small
"""

_CORRECTION = "你的输出不合法：{error}。请只输出 JSON，且 mode 必须是 chat、builder、debugger 三者之一。"


@dataclass(slots=True)
class Intent:
    mode: str
    scale: str
    needs_proposal: bool
    reason: str
    #: 一句话用户意图（持久化，供后续按轮总结使用）
    intent: str = ""
    usage: dict[str, int] | None = None
    #: 是否走了降级（模型不配合 / 接口不支持结构化输出）
    degraded: bool = False

    @property
    def should_plan(self) -> bool:
        return self.scale == "large"


def _fallback(reason: str, usage: dict[str, int] | None = None) -> Intent:
    return Intent("chat", "small", False, f"意图识别失败，按 Chat 处理（{reason}）", "", usage, degraded=True)


def _is_format_rejection(message: str) -> bool:
    lowered = message.lower()
    return any(
        hint in lowered
        for hint in ("response_format", "json_schema", "json schema", "strict", "unsupported parameter")
    )


def _user_prompt(text: str, history: list[dict[str, str]] | None) -> str:
    lines: list[str] = []
    recent = (history or [])[-4:]
    if recent:
        lines.append("最近对话（仅供参考）：")
        for item in recent:
            role = item.get("role") or "user"
            body = str(item.get("text") or "")[:600]
            lines.append(f"{role}: {body}")
        lines.append("")
    lines.append("当前用户消息：")
    lines.append(text[:4000])
    return "\n".join(lines)


def _extract_json(content: str) -> tuple[dict[str, Any] | None, str]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        value = json.loads(text)
        return (value, "") if isinstance(value, dict) else (None, "输出不是 JSON 对象")
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return None, "输出里找不到 JSON 对象"
        try:
            value = json.loads(match.group(0))
            return (value, "") if isinstance(value, dict) else (None, "输出不是 JSON 对象")
        except json.JSONDecodeError:
            return None, "JSON 解析失败"


def _parse(content: str) -> tuple[Intent | None, str]:
    data, error = _extract_json(content)
    if data is None:
        return None, error

    mode = str(data.get("mode") or "").strip().lower()
    if mode not in MODES:
        return None, f"mode={mode!r} 不在 chat/builder/debugger 之内"

    scale = str(data.get("scale") or "small").strip().lower()
    if scale not in ("small", "large"):
        scale = "small"

    raw_needs = data.get("needs_proposal")
    needs = bool(raw_needs) if isinstance(raw_needs, bool) else mode != "chat"
    reason = str(data.get("reason") or "").strip()[:200]
    intent_text = str(data.get("intent") or "").strip()[:200]
    return (
        Intent(
            mode=mode,
            scale=scale,
            needs_proposal=needs,
            reason=reason or "模型判定",
            intent=intent_text,
        ),
        "",
    )


async def classify(
    client: OpenAIClient,
    text: str,
    history: list[dict[str, str]] | None = None,
    *,
    log: Callable[[str], None] | None = None,
) -> Intent:
    """调一次主模型做意图分类。失败时退回 chat，绝不把异常抛给上层。"""
    say = log or (lambda _m: None)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": _user_prompt(text, history)},
    ]
    formats: list[dict[str, Any] | None] = [
        {"type": "json_schema", "json_schema": {"name": "intent", "strict": True, "schema": INTENT_SCHEMA}},
        {"type": "json_object"},
        None,
    ]

    usage_total: dict[str, int] | None = None
    format_index = 0
    validation_retries = 0

    for attempt in range(4):
        response_format = formats[min(format_index, len(formats) - 1)]
        try:
            content, usage = await client.complete(messages, response_format=response_format, timeout=25.0)
        except ModelError as exc:
            if response_format is not None and _is_format_rejection(str(exc)):
                say(f"意图识别：服务端不支持 {response_format.get('type')}，降级重试")
                format_index += 1
                continue
            say(f"意图识别失败：{exc}")
            return _fallback(str(exc), usage_total)

        if usage:
            usage_total = (
                usage
                if usage_total is None
                else {
                    "inputTokens": usage_total.get("inputTokens", 0) + usage.get("inputTokens", 0),
                    "outputTokens": usage_total.get("outputTokens", 0) + usage.get("outputTokens", 0),
                }
            )

        intent, error = _parse(content)
        if intent is not None:
            intent.usage = usage_total
            intent.degraded = attempt > 0 or format_index > 0
            return intent

        validation_retries += 1
        say(f"意图识别：输出不合法（{error}），要求模型重试")
        if validation_retries > 2:
            return _fallback(error, usage_total)
        messages = [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": _user_prompt(text, history)},
            {"role": "assistant", "content": content[:500]},
            {"role": "user", "content": _CORRECTION.format(error=error)},
        ]

    return _fallback("尝试次数用尽", usage_total)
