"""视觉能力判定：显式设置优先，其次"试过才知道"。

不再枚举模型名（`gpt-4o` / `qwen-vl` …）——那种名单永远滞后于新模型，
也挡不住私有部署改名。现在的策略：

  1. 用户显式 `supportsVision: "on" / "off"` → 直接采信（唯一 100% 可靠的来源）
  2. 之前被服务端拒绝过（缓存为 False）→ 不再发图片
  3. 之前带图成功过（缓存为 True）→ 继续发图片
  4. 都没记录 → **乐观**：先带图发；如果服务端明确说"不支持图片"，
     由调用方剥掉图片重试，并把 False 写进缓存

缓存按 `baseUrl + model` 记，换网关或换模型自然失效；进程内有效
（内核重启后重新学习，避免把一次临时故障记成永久结论）。
"""

from __future__ import annotations

#: (baseUrl, model) → 是否支持图片
_CACHE: dict[tuple[str, str], bool] = {}


def resolve_vision(model: str, setting: str | None, base_url: str) -> bool | None:
    """返回 True/False；`None` 表示"还不知道"（调用方应乐观地先试）。"""
    normalized = (setting or "auto").strip().lower()
    if normalized in ("on", "true", "yes", "1"):
        return True
    if normalized in ("off", "false", "no", "0"):
        return False
    return _CACHE.get((base_url.strip(), model.strip()))


def remember(model: str, base_url: str, supported: bool) -> None:
    """记录一次学习结果（发送成功 / 被服务端拒绝后调用）。"""
    _CACHE[(base_url.strip(), model.strip())] = supported


def forget(base_url: str | None = None) -> None:
    """清空缓存（测试用；将来也可以在模型配置变更时调用）。"""
    if base_url is None:
        _CACHE.clear()
        return
    for key in [k for k in _CACHE if k[0] == base_url.strip()]:
        _CACHE.pop(key, None)
