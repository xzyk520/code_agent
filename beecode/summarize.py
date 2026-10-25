"""Per-turn summaries based on "user intent" (model call, structured output).

Purpose: during context compression, squeeze "the earlier N turns" into a group of sentences.
Each sentence must cover three things:

  1. which tools were called
  2. which files were changed
  3. which requirement was implemented

Input is the turn records persisted on the shell side (intent + AI answer + tool names +
files); output is a set of `{intent, summary}` pairs, which the shell then joins into a
summary block and injects into system.

Degradation: when the server does not support `response_format`, fall back step by step to
`json_object` → plain-text parsing; when the model does not follow the schema, retry once
and fail as a whole if it still does not (the shell then falls back to a mechanical summary).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from .llm.openai import ModelError, OpenAIClient

SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "pairs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "intent": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["intent", "summary"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["pairs"],
    "additionalProperties": False,
}

_SYSTEM = """你是对话历史压缩器。输入是一组"轮次"，每轮包含：用户意图（intent）、AI 的回答、
调用过的工具（tools）、改动的文件（files）、工具观察（observations）、
生成的图（diagrams：kind/title/source）。

请为**每一轮**写一句中文总结，句子必须包含三部分信息：
1. 调用了什么工具（没调用就写"未调用工具"）
2. 改动了哪些文件（没改动就写"未改动文件"）
3. 实现了什么需求（对应用户意图）
如果这轮画了图，在总结末尾补一句"并画了示意图：<主题>"。

示例：
{"pairs":[{"intent":"修复配置读取崩溃","summary":"调用了 read_file、propose_edit，改动了 src/config.ts，修复了空配置导致的崩溃"}]}

只输出 JSON，不要解释。pairs 的数量和顺序必须与输入轮次一致，intent 原样返回。
"""


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _extract_json(content: str) -> dict[str, Any] | None:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    for candidate in (text, (re.search(r"\{.*\}", text, re.DOTALL) or [None])[0]):
        if not candidate:
            continue
        try:
            value = json.loads(candidate)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue
    return None


def _prepare(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for turn in turns[:40]:
        prepared.append(
            {
                "intent": _truncate(str(turn.get("intent") or "（未记录意图）"), 200),
                "assistant": _truncate(str(turn.get("assistant") or ""), 1200),
                "tools": [str(t) for t in (turn.get("tools") or [])][:10],
                "files": [str(f) for f in (turn.get("files") or [])][:10],
                "observations": [str(o)[:200] for o in (turn.get("observations") or [])][:12],
                "diagrams": [
                    {
                        "kind": str(d.get("kind") or "mermaid")[:20],
                        "title": str(d.get("title") or "")[:100],
                        "source": _truncate(str(d.get("source") or ""), 1200),
                    }
                    for d in (turn.get("diagrams") or [])[:4]
                    if isinstance(d, dict)
                ],
            }
        )
    return prepared


def _validate(data: dict[str, Any], expected: int) -> list[dict[str, str]]:
    pairs = data.get("pairs")
    if not isinstance(pairs, list) or len(pairs) != expected:
        raise ValueError(f"pairs 数量不匹配（期望 {expected}，得到 {len(pairs) if isinstance(pairs, list) else '非数组'}）")
    out: list[dict[str, str]] = []
    for item in pairs:
        if not isinstance(item, dict):
            raise ValueError("pairs 元素不是对象")
        intent = str(item.get("intent") or "").strip()
        summary = str(item.get("summary") or "").strip()
        if not intent or not summary:
            raise ValueError("pairs 元素缺少 intent 或 summary")
        out.append({"intent": intent[:200], "summary": summary[:400]})
    return out


async def summarize_turns(
    client: OpenAIClient,
    turns: list[dict[str, Any]],
    *,
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Return `{summary, pairs, usage}`; raise ModelError on failure (the shell falls back to a mechanical summary)."""
    say = log or (lambda _m: None)
    prepared = _prepare(turns)
    if not prepared:
        return {"summary": "", "pairs": [], "usage": None}

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": json.dumps({"turns": prepared}, ensure_ascii=False)},
    ]
    formats: list[dict[str, Any] | None] = [
        {"type": "json_schema", "json_schema": {"name": "turn_summary", "strict": True, "schema": SUMMARY_SCHEMA}},
        {"type": "json_object"},
        None,
    ]

    usage: dict[str, int] | None = None
    format_index = 0
    last_error = ""
    for attempt in range(4):
        response_format = formats[min(format_index, len(formats) - 1)]
        try:
            content, raw_usage = await client.complete(messages, response_format=response_format, timeout=45.0)
        except ModelError as exc:
            if response_format is not None and any(
                hint in str(exc).lower() for hint in ("response_format", "json_schema", "json schema", "strict")
            ):
                say("Summary: server does not support structured output, retrying with fallback")
                format_index += 1
                continue
            raise
        if raw_usage:
            usage = raw_usage

        data = _extract_json(content)
        if data is None:
            last_error = "输出不是 JSON"
        else:
            try:
                pairs = _validate(data, len(prepared))
            except ValueError as exc:
                last_error = str(exc)
            else:
                summary = "\n".join(f"- {pair['intent']}：{pair['summary']}" for pair in pairs)
                return {"summary": f"[早前对话摘要 · 模型生成]\n{summary}", "pairs": pairs, "usage": usage}

        say(f"Summary: invalid output ({last_error}), retrying (attempt {attempt + 1})")
        messages = messages[:2] + [
            {"role": "assistant", "content": content[:1000]},
            {"role": "user", "content": f"输出不合法：{last_error}。请严格按 schema 输出 JSON。"},
        ]

    raise ModelError(f"摘要生成失败：{last_error or '未知原因'}")
