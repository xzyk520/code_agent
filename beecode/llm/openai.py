"""OpenAI 兼容的流式聊天客户端（SSE）。

只依赖 `httpx`，不依赖任何厂商 SDK —— 这样换供应商只改 `base_url` 和 `model`。

约定：
  - `base_url` 可以是 `https://api.openai.com/v1`（自动补 `/chat/completions`），
    也可以直接给完整的 `.../chat/completions` 地址。
  - 流式增量按 `choices[0].delta.content` 取；工具调用按 `delta.tool_calls` 分片累积；
    `[DONE]` 结束。
  - 任何失败都抛 `ModelError`（消息面向用户，不含堆栈）。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

#: 连接超时短一些（连不上要尽快报错），读超时长一些（模型可能在思考）
CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 180.0


class ModelError(RuntimeError):
    """模型调用失败。

    `message` 会直接显示给用户；`code` 用于决定是否重试（不要靠解析 message）。
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
    """服务端明确表示"不支持这种输入"（目前用于图片）。

    调用方应该剥掉图片重试一次，并把"该模型不支持图片"记下来。
    """

    def __init__(self, message: str, *, status: int, body: str) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class ReasoningReplayRequired(ModelError):
    """服务端要求把思考内容回传（缺少 reasoning_content 时才会抛）。"""


#: 服务端拒绝图片时常见的措辞（只认这些，别把所有 400 都当成"没视觉"）
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
    """模型请求的一次工具调用（分片已经拼好）。"""

    id: str
    name: str
    arguments: str


@dataclass(slots=True)
class ChatDelta:
    """流式事件：增量文本 / 结束原因 / 用量 / 工具调用（其余都可能为空）。"""

    text: str = ""
    finish_reason: str | None = None
    usage: dict[str, int] | None = None
    #: 只在流结束时出现一次（参数已拼完整）
    tool_calls: list[ToolCall] | None = None
    #: 思考内容增量（DeepSeek `reasoning_content` / OpenRouter `reasoning` / 网关 `thinking`）
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

    # ───────────────────────── 公开 ─────────────────────────

    @property
    def chat_url(self) -> str:
        """把用户填的 base_url 归一化成 chat/completions 地址。"""
        base = self._base_url.rstrip("/")
        if not base:
            raise ModelError("未配置 base_url：请在命令面板运行「Bee Code: 配置模型」")
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
        """流式产出增量。调用方负责把 `text` 转发给壳。"""
        if not self._model:
            raise ModelError("未配置 model：请在命令面板运行「Bee Code: 配置模型」")
        if not self._api_key:
            raise ModelError("未配置 API Key：请在命令面板运行「Bee Code: 配置模型」")

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
                                f"模型不接受图片输入（HTTP {response.status_code}）：{body[:200]}",
                                status=response.status_code,
                                body=body,
                            )
                        if _is_reasoning_rejection(body):
                            raise ReasoningReplayRequired(
                                f"服务端要求回传思考内容（HTTP {response.status_code}）：{body[:200]}"
                            )
                        raise ModelError(
                            _explain_http_error(response.status_code, body),
                            code=_error_code_for_status(response.status_code),
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
            raise ModelError(f"模型响应超时（{READ_TIMEOUT:.0f}s）：{exc}", code="TIMEOUT") from exc
        except httpx.HTTPError as exc:
            # TLS/证书问题不是瞬时网络抖动，重试只会重复失败
            code = "INVALID" if "certificate" in str(exc).lower() else "TRANSPORT"
            raise ModelError(f"连接模型失败：{exc}", code=code) from exc

    async def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        response_format: dict[str, Any] | None = None,
        temperature: float = 0.0,
        timeout: float = 30.0,
    ) -> tuple[str, dict[str, int] | None]:
        """非流式补全（意图分类这类"要一段 JSON"的场景用）。

        返回 (content, usage)。失败抛 ModelError；不处理图片能力（分类不需要图）。
        """
        if not self._model:
            raise ModelError("未配置 model：请在命令面板运行「Bee Code: 配置模型」")
        if not self._api_key:
            raise ModelError("未配置 API Key：请在命令面板运行「Bee Code: 配置模型」")

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
                        code=_error_code_for_status(response.status_code),
                        status=response.status_code,
                        retry_after=_retry_after_seconds(response.headers),
                    )
                data = json.loads(body)
        except httpx.TimeoutException as exc:
            raise ModelError(f"模型响应超时（{timeout:.0f}s）：{exc}", code="TIMEOUT") from exc
        except httpx.HTTPError as exc:
            # TLS/证书问题不是瞬时网络抖动，重试只会重复失败
            code = "INVALID" if "certificate" in str(exc).lower() else "TRANSPORT"
            raise ModelError(f"连接模型失败：{exc}", code=code) from exc

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
        """占位：目前每次请求自建连接池，无需显式关闭。"""


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
        hint = "（API Key 无效或未授权）"
    elif status == 404:
        hint = "（base_url 可能不对：应指向 /v1 或完整的 /chat/completions）"
    elif status == 429:
        hint = "（限流或余额不足）"
    return f"模型返回 HTTP {status}{hint}：{body}"


def _is_reasoning_rejection(body: str) -> bool:
    lowered = body.lower()
    if "reasoning" not in lowered and "thinking" not in lowered:
        return False
    return any(word in lowered for word in ("required", "missing", "must", "absent", "not found"))


def _reasoning_text(delta: dict[str, Any]) -> str:
    """从 delta 里取出思考文本（不同厂商字段不同）。"""
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
    """解析一行 SSE。非数据行、心跳、`[DONE]` 都返回空列表。"""
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

    # 多数厂商把 usage 放在最后一个带 choices 的包里；有些单独发一个 choices=[]
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

        # 工具调用分片：index / id / function.name / function.arguments 都可能分批到达
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
    """把累积的分片整理成有序的工具调用列表（缺 id 时补一个稳定的假 id）。"""
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
    """粗估 token（CJK 1 字 ≈ 1 token，ASCII 4 字符 ≈ 1 token）。仅用于缺 usage 时兜底。"""
    cjk = sum(1 for ch in text if "\u2e80" <= ch <= "\u9fff" or "\uac00" <= ch <= "\ud7af")
    return int(cjk + (len(text) - cjk) / 4)
