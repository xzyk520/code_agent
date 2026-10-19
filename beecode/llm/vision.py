"""判断当前模型能不能看图。

三种来源（优先级从高到低）：
  1. 用户显式设置 `beeCode.model.supportsVision`: "on" / "off"
  2. 模型名启发式（覆盖主流视觉模型命名）
  3. 默认关闭（保守：宁可把图片省略成文字提示，也不让请求 400）

为什么不探测 `/models`：OpenAI 兼容端点返回的元数据里几乎没有模态信息，
问了也白问；真正可靠的只有"用户告诉我们"或"厂商命名约定"。
"""

from __future__ import annotations

#: 模型名里出现这些片段就认为支持图像
_VISION_HINTS = (
    "gpt-4o",
    "gpt-4.1",
    "gpt-5",
    "o3",
    "o4",
    "claude-3",
    "claude-4",
    "claude-sonnet",
    "claude-opus",
    "gemini",
    "qwen-vl",
    "qwen2-vl",
    "qwen2.5-vl",
    "qwen3-vl",
    "glm-4v",
    "glm-4.5v",
    "llava",
    "pixtral",
    "internvl",
    "minicpm-v",
    "phi-3-vision",
    "phi-4-multimodal",
    "moondream",
    "cogvlm",
    "internlm-xcomposer",
    "step-1v",
    "yi-vl",
)


def supports_vision(model: str, setting: str | None) -> bool:
    """`setting` 取 "on" / "off" / "auto"（或空）。"""
    normalized = (setting or "auto").strip().lower()
    if normalized in ("on", "true", "yes", "1"):
        return True
    if normalized in ("off", "false", "no", "0"):
        return False

    name = (model or "").strip().lower()
    if not name:
        return False
    return any(hint in name for hint in _VISION_HINTS)
