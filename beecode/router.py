"""Intent classification: **ask the main model to decide**, no keyword hardcoding.

Output is constrained to three classes (chat / builder / debugger). JSON Schema is preferred
to force structure; when the server does not support `response_format` we degrade step by
step (json_object → plain text + parsing). If the model returns a value outside the three
classes we feed the error back and ask it to correct itself; if it is still invalid twice in
a row we fall back to chat (better a wrong classification than failing the whole turn).
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
        "continue_previous": {"type": "boolean"},
    },
    "required": ["mode", "scale", "needs_proposal", "reason", "intent", "continue_previous"],
    "additionalProperties": False,
}

_SYSTEM = """You are the intent classifier for Bee Code. Output only a JSON object; do not include any explanation or Markdown.

Fields:
- mode: "chat" | "builder" | "debugger"
- scale: "small" | "large"
- needs_proposal: boolean (whether this turn should produce a file modification proposal)
- reason: a one-sentence explanation (why you made this decision)
- intent: a one-sentence summary of "what the user wants to achieve" (used for later summaries; do not include implementation details)
- continue_previous: boolean (whether this message **continues** the previous turn's intent rather than switching goals)

Decision rules:
- chat: explain code, answer questions, discuss approaches; no file changes needed
- builder: add/modify/refactor/migrate code; a file modification is expected
- debugger: locate and fix errors, exceptions, crashes, or behavior that does not match expectations
- builder and debugger **default to needs_proposal=true**; set it to false only when the user explicitly says "discuss first / do not change anything"
- scale=large: involves multiple files, architectural changes, migrations, or a very long requirements description; otherwise small
- continue_previous=true only when the user is adding information, answering a follow-up question, or saying "continue/go on" without changing the goal;
  set it to false as soon as a new goal, new object, or new constraint appears
"""

_CORRECTION = "Your output is invalid: {error}. Output only JSON, and mode must be one of chat, builder, or debugger."


@dataclass(slots=True)
class Intent:
    mode: str
    scale: str
    needs_proposal: bool
    reason: str
    #: One-sentence user intent (persisted, used by later per-turn summaries)
    intent: str = ""
    usage: dict[str, int] | None = None
    #: Whether a degraded path was taken (model uncooperative / endpoint without structured output)
    degraded: bool = False
    #: Model decision: whether this continues the previous turn's intent
    continues_previous: bool = False

    @property
    def should_plan(self) -> bool:
        return self.scale == "large"


def _fallback(reason: str, usage: dict[str, int] | None = None) -> Intent:
    return Intent("chat", "small", False, f"Intent classification failed; falling back to chat ({reason})", "", usage, degraded=True)


def _is_format_rejection(message: str) -> bool:
    lowered = message.lower()
    return any(
        hint in lowered
        for hint in ("response_format", "json_schema", "json schema", "strict", "unsupported parameter")
    )


def _user_prompt(
    text: str,
    history: list[dict[str, str]] | None,
    previous: dict[str, Any] | None = None,
) -> str:
    lines: list[str] = []
    if previous:
        lines.append("Previous turn's intent:")
        lines.append(
            f"- Goal: {str(previous.get('intent') or '').strip()[:200] or '(not recorded)'}\n"
            f"- Task scale: {previous.get('scale') or 'small'} (small=single point/small change, large=multiple files/architecture/migration)\n"
            f"- Mode: {previous.get('mode') or 'chat'}\n"
            f"- Needs a proposal: {'yes' if previous.get('needs_proposal') else 'no'}"
        )
        lines.append("Decide whether the current message continues that intent or switches to a new goal.")
        lines.append("")
    recent = (history or [])[-4:]
    if recent:
        lines.append("Recent conversation (for reference only):")
        for item in recent:
            role = item.get("role") or "user"
            body = str(item.get("text") or "")[:600]
            lines.append(f"{role}: {body}")
        lines.append("")
    lines.append("Current user message:")
    lines.append(text[:4000])
    return "\n".join(lines)


def _extract_json(content: str) -> tuple[dict[str, Any] | None, str]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        value = json.loads(text)
        return (value, "") if isinstance(value, dict) else (None, "Output is not a JSON object")
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return None, "No JSON object found in the output"
        try:
            value = json.loads(match.group(0))
            return (value, "") if isinstance(value, dict) else (None, "Output is not a JSON object")
        except json.JSONDecodeError:
            return None, "JSON parsing failed"


def _parse(content: str) -> tuple[Intent | None, str]:
    data, error = _extract_json(content)
    if data is None:
        return None, error

    mode = str(data.get("mode") or "").strip().lower()
    if mode not in MODES:
        return None, f"mode={mode!r} is not one of chat/builder/debugger"

    scale = str(data.get("scale") or "small").strip().lower()
    if scale not in ("small", "large"):
        scale = "small"

    raw_needs = data.get("needs_proposal")
    needs = bool(raw_needs) if isinstance(raw_needs, bool) else mode != "chat"
    reason = str(data.get("reason") or "").strip()[:200]
    intent_text = str(data.get("intent") or "").strip()[:200]
    raw_continue = data.get("continue_previous")
    continues = bool(raw_continue) if isinstance(raw_continue, bool) else False
    return (
        Intent(
            mode=mode,
            scale=scale,
            needs_proposal=needs,
            reason=reason or "model decision",
            intent=intent_text,
            continues_previous=continues,
        ),
        "",
    )


async def classify(
    client: OpenAIClient,
    text: str,
    history: list[dict[str, str]] | None = None,
    *,
    log: Callable[[str], None] | None = None,
    previous: dict[str, Any] | None = None,
) -> Intent:
    """Call the main model once to classify intent. On failure fall back to chat; never raise to the caller."""
    say = log or (lambda _m: None)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": _user_prompt(text, history, previous)},
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
                say(f"Intent classification: server does not support {response_format.get('type')}, retrying with fallback")
                format_index += 1
                continue
            say(f"Intent classification failed: {exc}")
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
        say(f"Intent classification: invalid output ({error}), asking the model to retry")
        if validation_retries > 2:
            return _fallback(error, usage_total)
        messages = [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": _user_prompt(text, history)},
            {"role": "assistant", "content": content[:500]},
            {"role": "user", "content": _CORRECTION.format(error=error)},
        ]

    return _fallback("attempts exhausted", usage_total)
