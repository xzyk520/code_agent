"""OpenAI-compatible client: it does exactly one thing — **streaming** chat completions.

Why standardize on the OpenAI format: DeepSeek / Qwen / Kimi / GLM / OpenRouter / Ollama /
vLLM all provide a compatibility layer. Users only need to fill in `base_url` + `model` +
`api_key`.
"""

from __future__ import annotations

from .openai import (
    ChatDelta,
    ModelCapabilityError,
    ModelError,
    OpenAIClient,
    ReasoningReplayRequired,
    ToolCall,
    estimate_tokens,
)
from .vision import forget, remember, resolve_vision

__all__ = [
    "ChatDelta",
    "ModelCapabilityError",
    "ModelError",
    "OpenAIClient",
    "ReasoningReplayRequired",
    "ToolCall",
    "estimate_tokens",
    "forget",
    "remember",
    "resolve_vision",
]
