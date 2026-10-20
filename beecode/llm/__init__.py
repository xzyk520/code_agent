"""OpenAI 兼容客户端：只做一件事——**流式**聊天补全。

为什么统一成 OpenAI 格式：DeepSeek / Qwen / Kimi / GLM / OpenRouter / Ollama / vLLM
都提供兼容层。用户只需要填 `base_url` + `model` + `api_key`。
"""

from __future__ import annotations

from .openai import ChatDelta, ModelCapabilityError, ModelError, OpenAIClient, ToolCall, estimate_tokens
from .vision import forget, remember, resolve_vision

__all__ = [
    "ChatDelta",
    "ModelCapabilityError",
    "ModelError",
    "OpenAIClient",
    "ToolCall",
    "estimate_tokens",
    "forget",
    "remember",
    "resolve_vision",
]
