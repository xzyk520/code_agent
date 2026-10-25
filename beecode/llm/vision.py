"""Vision capability detection: explicit settings win, otherwise "try and see".

We no longer enumerate model names (`gpt-4o` / `qwen-vl` …) — such lists always lag
behind new models and cannot cope with private deployments being renamed. The current
strategy:

  1. The user explicitly sets `supportsVision: "on" / "off"` → trust it directly (the only
     100% reliable source)
  2. Previously rejected by the server (cached as False) → stop sending images
  3. Previously succeeded with an image (cached as True) → keep sending images
  4. Nothing recorded → **optimistic**: send the image first; if the server explicitly says
     "images are not supported", the caller strips the image and retries, writing False
     into the cache

The cache is keyed by `baseUrl + model`, so switching gateways or models invalidates it
naturally; it lives for the process only (the kernel relearns after a restart, so a
temporary failure is never recorded as a permanent conclusion).
"""

from __future__ import annotations

#: (baseUrl, model) → whether images are supported
_CACHE: dict[tuple[str, str], bool] = {}


def resolve_vision(model: str, setting: str | None, base_url: str) -> bool | None:
    """Return True/False; `None` means "not known yet" (the caller should try optimistically)."""
    normalized = (setting or "auto").strip().lower()
    if normalized in ("on", "true", "yes", "1"):
        return True
    if normalized in ("off", "false", "no", "0"):
        return False
    return _CACHE.get((base_url.strip(), model.strip()))


def remember(model: str, base_url: str, supported: bool) -> None:
    """Record one learned result (called after a successful send / a server rejection)."""
    _CACHE[(base_url.strip(), model.strip())] = supported


def forget(base_url: str | None = None) -> None:
    """Clear the cache (used by tests; can also be called when the model config changes)."""
    if base_url is None:
        _CACHE.clear()
        return
    for key in [k for k in _CACHE if k[0] == base_url.strip()]:
        _CACHE.pop(key, None)
