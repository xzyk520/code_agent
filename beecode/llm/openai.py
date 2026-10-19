"""OpenAI 兼容的流式聊天客户端（SSE）。

只依赖 `httpx`，不依赖任何厂商 SDK —— 这样换供应商只改 `base_url` 和 `model`。

约定：
  - `base_url` 可以是 `https://api.openai.com/v1`（自动补 `/chat/completions`），
    也可以直接给完整的 `.../chat/completions` 地址。
  - 流式增量按 `choices[0].delta.content` 取；`[DONE]` 结束。
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
    """模型调用失败。`message` 会直接显示给用户，所以要写人话。"""


@dataclass(slots=True)
class ChatDelta:
    """流式事件：增量文本 / 结束原因 / 用量（三者都可能为空）。"""

    text: str = ""
    finish_reason: str | None = None
    usage: dict[str, int] | None = None


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
                        raise ModelError(_explain_http_error(response.status_code, body))

                    async for line in response.aiter_lines():
                        for delta in _parse_sse_line(line):
                            yield delta
        except httpx.TimeoutException as exc:
            raise ModelError(f"模型响应超时（{READ_TIMEOUT:.0f}s）：{exc}") from exc
        except httpx.HTTPError as exc:
            raise ModelError(f"连接模型失败：{exc}") from exc

    async def close(self) -> None:
        """占位：目前每次请求自建连接池，无需显式关闭。"""


def _explain_http_error(status: int, body: str) -> str:
    hint = ""
    if status == 401:
        hint = "（API Key 无效或未授权）"
    elif status == 404:
        hint = "（base_url 可能不对：应指向 /v1 或完整的 /chat/completions）"
    elif status == 429:
        hint = "（限流或余额不足）"
    return f"模型返回 HTTP {status}{hint}：{body}"


def _parse_sse_line(line: str) -> list[ChatDelta]:
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
        finish = choice.get("finish_reason")
        if isinstance(text, str) and text:
            out.append(ChatDelta(text=text))
        if finish:
            out.append(ChatDelta(finish_reason=str(finish)))
    return out


def estimate_tokens(text: str) -> int:
    """粗估 token（CJK 1 字 ≈ 1 token，ASCII 4 字符 ≈ 1 token）。仅用于缺 usage 时兜底。"""
    cjk = sum(1 for ch in text if "\u2e80" <= ch <= "\u9fff" or "\uac00" <= ch <= "\ud7af")
    return int(cjk + (len(text) - cjk) / 4)
