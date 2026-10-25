"""OpenAI-compatible streaming chat client (SSE).

Depends only on `httpx` and no vendor SDK, so switching providers only requires changing
`base_url` and `model`.

Conventions:
  - `base_url` can be `https://api.openai.com/v1` (the client appends `/chat/completions`),
    or the complete `.../chat/completions` URL.
  - Streaming deltas come from `choices[0].delta.content`; tool calls accumulate from
    `delta.tool_calls` fragments; `[DONE]` terminates the stream.
  - Every failure raises `ModelError` (the message is user-facing and contains no stack trace).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

#: Keep the connect timeout short (fail fast when unreachable) and the read timeout longer (the model may be thinking)
CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 180.0


class ModelError(RuntimeError):
    """A model call failed.

    `message` is shown directly to the user; `code` decides whether to retry (never parse
    `message` to make that decision).
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "UNKNOWN",
        status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retry_after = retry_after


class ModelCapabilityError(ModelError):
    """The server explicitly says "this input is not supported" (currently used for images).

    The caller should strip the image and retry once, and record that "this model does not
    support images".
    """

    def __init__(self, message: str, *, status: int, body: str) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class ReasoningReplayRequired(ModelError):
    """The server requires reasoning content to be replayed (raised only when reasoning_content is missing)."""


#: Common wording used by servers to reject images (only these count; do not treat every 400 as "no vision")
_IMAGE_REJECT_HINTS = (
    "image",
    "vision",
    "multimodal",
    "modality",
    "image_url",
    "content type",
    "unsupported content",
)


def _is_image_rejection(status: int, body: str) -> bool:
    if status not in (400, 415, 422):
        return False
    lowered = body.lower()
    return any(hint in lowered for hint in _IMAGE_REJECT_HINTS)


@dataclass(slots=True)
class ToolCall:
    """One tool call requested by the model (fragments have already been assembled)."""

    id: str
    name: str
    arguments: str


@dataclass(slots=True)
class ChatDelta:
    """A streaming event: delta text / finish reason / usage / tool calls (the rest may be empty)."""

    text: str = ""
    finish_reason: str | None = None
    usage: dict[str, int] | None = None
    #: Appears only once at the end of the stream (arguments are fully assembled)
    tool_calls: list[ToolCall] | None = None
    #: Reasoning-content delta (DeepSeek `reasoning_content` / OpenRouter `reasoning` / gateway `thinking`)
    reasoning: str = ""


class OpenAIClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str | None,
        *,
        timeout: float = READ_TIMEOUT,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self._base_url = (base_url or "").strip()
        self._model = (model or "").strip()
        self._api_key = api_key
        self._extra_headers = extra_headers or {}
        self._timeout = httpx.Timeout(timeout, connect=CONNECT_TIMEOUT)

    # ───────────────────────── Public API ─────────────────────────

    @property
    def chat_url(self) -> str:
        """Normalize the user-supplied base_url into a chat/completions URL."""
        base = self._base_url.rstrip("/")
        if not base:
            raise ModelError('base_url is not configured: run "Bee Code: Configure Model" from the command palette')
        if base.endswith("/chat/completions"):
            return base
        return f"{base}/chat/completions"

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
    ) -> AsyncIterator[ChatDelta]:
        """Yield stream deltas. The caller is responsible for forwarding `text` to the shell."""
        if not self._model:
            raise ModelError('model is not configured: run "Bee Code: Configure Model" from the command palette')
        if not self._api_key:
            raise ModelError('API key is not configured: run "Bee Code: Configure Model" from the command palette')

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "stream": True,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if temperature is not None:
            payload["temperature"] = temperature

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            **self._extra_headers,
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                async with client.stream("POST", self.chat_url, json=payload, headers=headers) as response:
                    if response.status_code >= 400:
                        body = (await response.aread()).decode("utf-8", "replace")[:500]
                        if _is_image_rejection(response.status_code, body):
                            raise ModelCapabilityError(
                                f"The model does not accept image input (HTTP {response.status_code}): {body[:200]}",
                                status=response.status_code,
                                body=body,
                            )
                        if _is_reasoning_rejection(body):
                            raise ReasoningReplayRequired(
                                f"The server requires reasoning content to be replayed (HTTP {response.status_code}): {body[:200]}"
                            )
                        raise ModelError(
                            _explain_http_error(response.status_code, body),
                            code=(
                                "CONTEXT_OVERFLOW"
                                if _is_context_overflow(response.status_code, body)
                                else _error_code_for_status(response.status_code)
                            ),
                            status=response.status_code,
                            retry_after=_retry_after_seconds(response.headers),
                        )

                    calls: dict[int, dict[str, str]] = {}
                    async for line in response.aiter_lines():
                        for delta in _parse_sse_line(line, calls):
                            yield delta

                    finished = _finish_calls(calls)
                    if finished:
                        yield ChatDelta(tool_calls=finished)
        except httpx.TimeoutException as exc:
            raise ModelError(f"Model response timed out ({READ_TIMEOUT:.0f}s): {exc}", code="TIMEOUT") from exc
        except httpx.HTTPError as exc:
            # TLS/certificate problems are not transient network blips; retrying only repeats the failure
            code = "INVALID" if "certificate" in str(exc).lower() else "TRANSPORT"
            raise ModelError(f"Failed to connect to the model: {exc}", code=code) from exc

    async def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        response_format: dict[str, Any] | None = None,
        temperature: float = 0.0,
        timeout: float = 30.0,
    ) -> tuple[str, dict[str, int] | None]:
        """Non-streaming completion (for intent classification and similar "need a JSON blob" cases).

        Returns (content, usage). Raises ModelError on failure; does not handle image
        capabilities (classification does not need images).
        """
        if not self._model:
            raise ModelError('model is not configured: run "Bee Code: Configure Model" from the command palette')
        if not self._api_key:
            raise ModelError('API key is not configured: run "Bee Code: Configure Model" from the command palette')

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "temperature": temperature,
            "stream": False,
        }
        if response_format is not None:
            payload["response_format"] = response_format
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            **self._extra_headers,
        }

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=CONNECT_TIMEOUT)) as client:
                response = await client.post(self.chat_url, json=payload, headers=headers)
                body = response.text
                if response.status_code >= 400:
                    raise ModelError(
                        _explain_http_error(response.status_code, body[:500]),
                        code=(
                            "CONTEXT_OVERFLOW"
                            if _is_context_overflow(response.status_code, body[:500])
                            else _error_code_for_status(response.status_code)
                        ),
                        status=response.status_code,
                        retry_after=_retry_after_seconds(response.headers),
                    )
                data = json.loads(body)
        except httpx.TimeoutException as exc:
            raise ModelError(f"Model response timed out ({timeout:.0f}s): {exc}", code="TIMEOUT") from exc
        except httpx.HTTPError as exc:
            # TLS/certificate problems are not transient network blips; retrying only repeats the failure
            code = "INVALID" if "certificate" in str(exc).lower() else "TRANSPORT"
            raise ModelError(f"Failed to connect to the model: {exc}", code=code) from exc

        choices = data.get("choices") or []
        content = ""
        if choices:
            content = str((choices[0].get("message") or {}).get("content") or "")
        usage = data.get("usage")
        usage_dict = None
        if isinstance(usage, dict):
            usage_dict = {
                "inputTokens": int(usage.get("prompt_tokens") or 0),
                "outputTokens": int(usage.get("completion_tokens") or 0),
            }
        return content, usage_dict

    async def close(self) -> None:
        """Placeholder: each request currently creates its own connection pool, so no explicit close is needed."""


def _is_context_overflow(status: int, body: str) -> bool:
    if status not in (400, 413):
        return False
    lowered = body.lower()
    hints = (
        "context length",
        "context window",
        "too many tokens",
        "maximum context",
        "reduce the length",
        "prompt is too long",
        "input is too long",
    )
    return any(hint in lowered for hint in hints)


def _error_code_for_status(status: int) -> str:
    if status in (408, 504):
        return "TIMEOUT"
    if status == 429:
        return "RATE_LIMIT"
    if status in (401, 403):
        return "AUTH"
    if status == 404:
        return "CONFIG"
    if status >= 500:
        return "SERVER"
    return "INVALID"


def _retry_after_seconds(headers: httpx.Headers) -> float | None:
    raw = headers.get("retry-after")
    if not raw:
        return None
    try:
        value = float(raw.strip())
    except ValueError:
        return None
    return value if value > 0 else None


def _explain_http_error(status: int, body: str) -> str:
    hint = ""
    if status == 401:
        hint = " (invalid or unauthorized API key)"
    elif status == 404:
        hint = " (base_url may be wrong: it should point to /v1 or the complete /chat/completions URL)"
    elif status == 429:
        hint = " (rate limited or insufficient balance)"
    return f"Model returned HTTP {status}{hint}: {body}"


def _is_reasoning_rejection(body: str) -> bool:
    lowered = body.lower()
    if "reasoning" not in lowered and "thinking" not in lowered:
        return False
    return any(word in lowered for word in ("required", "missing", "must", "absent", "not found"))


def _reasoning_text(delta: dict[str, Any]) -> str:
    """Extract reasoning text from a delta (the field differs between vendors)."""
    for key in ("reasoning_content", "reasoning", "thinking"):
        value = delta.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict):
            inner = value.get("text") or value.get("content")
            if isinstance(inner, str) and inner:
                return inner
    return ""


def _parse_sse_line(line: str, calls: dict[int, dict[str, str]]) -> list[ChatDelta]:
    """Parse one SSE line. Non-data lines, heartbeats, and `[DONE]` return an empty list."""
    if not line or not line.startswith("data:"):
        return []
    data = line[5:].strip()
    if not data or data == "[DONE]":
        return []
    try:
        chunk = json.loads(data)
    except json.JSONDecodeError:
        return []

    out: list[ChatDelta] = []

    # Most vendors put usage in the last chunk that has choices; some send a separate chunk with choices=[]
    usage = chunk.get("usage")
    if isinstance(usage, dict):
        out.append(
            ChatDelta(
                usage={
                    "inputTokens": int(usage.get("prompt_tokens") or 0),
                    "outputTokens": int(usage.get("completion_tokens") or 0),
                }
            )
        )

    choices = chunk.get("choices") or []
    if choices:
        choice = choices[0] or {}
        delta = choice.get("delta") or {}
        text = delta.get("content")
        if isinstance(text, str) and text:
            out.append(ChatDelta(text=text))

        reasoning = _reasoning_text(delta)
        if reasoning:
            out.append(ChatDelta(reasoning=reasoning))

        # Tool-call fragments: index / id / function.name / function.arguments may all arrive in pieces
        for item in delta.get("tool_calls") or []:
            index = int(item.get("index") or 0)
            slot = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
            if item.get("id"):
                slot["id"] = str(item["id"])
            function = item.get("function") or {}
            if function.get("name"):
                slot["name"] = str(function["name"])
            if function.get("arguments"):
                slot["arguments"] += str(function["arguments"])

        finish = choice.get("finish_reason")
        if finish:
            out.append(ChatDelta(finish_reason=str(finish)))
    return out


def _finish_calls(calls: dict[int, dict[str, str]]) -> list[ToolCall]:
    """Turn accumulated fragments into an ordered list of tool calls (supply a stable fake id when missing)."""
    out: list[ToolCall] = []
    for index in sorted(calls):
        slot = calls[index]
        if not slot["name"]:
            continue
        out.append(
            ToolCall(
                id=slot["id"] or f"call_{index}",
                name=slot["name"],
                arguments=slot["arguments"] or "{}",
            )
        )
    return out


def estimate_tokens(text: str) -> int:
    """Rough token estimate (about 1 token per CJK character, 1 token per 4 ASCII characters). Fallback only when usage is missing."""
    cjk = sum(1 for ch in text if "\u2e80" <= ch <= "\u9fff" or "\uac00" <= ch <= "\ud7af")
    return int(cjk + (len(text) - cjk) / 4)
