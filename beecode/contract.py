"""Runtime validation of the protocol contract (reconciled with `protocol/contract.json`).

Why this is needed: the interfaces in `src/protocol.ts` are TypeScript types that vanish
after compilation, so the Python side cannot see them at all; conversely TS cannot see
Python either. The "method names / parameter names" on both sides can only rely on one
**shared source of truth** — `protocol/contract.json`.

Validation points:
  - Before every RPC: the method name must exist in the contract, all required parameters
    must be present, and misspelled extra parameters are rejected
  - At startup (optional): the contract version must equal `ipc.PROTOCOL_VERSION`
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import ipc

CONTRACT_RELATIVE = Path("protocol") / "contract.json"


class ContractError(RuntimeError):
    """The contract was violated (misspelled method/parameter name, missing required field, version mismatch)"""


@lru_cache(maxsize=1)
def contract() -> dict[str, Any]:
    """Load the contract (cached in-process). Raises ContractError if the file is missing — without the contract, protocol correctness cannot be guaranteed."""
    searched: list[str] = []
    for root in _roots():
        candidate = root / CONTRACT_RELATIVE
        searched.append(str(candidate))
        if candidate.is_file():
            with candidate.open(encoding="utf-8") as handle:
                data = json.load(handle)
            _check_version(data)
            return data
    raise ContractError(f"找不到协议契约 {CONTRACT_RELATIVE}（已查找：{', '.join(searched)}）")


def shell_methods() -> dict[str, dict[str, Any]]:
    return dict(contract()["shellMethods"])


def core_methods() -> list[str]:
    return list(contract()["coreMethods"])


def notifications() -> list[str]:
    return list(contract()["notifications"])


def check_shell_call(method: str, params: dict[str, Any]) -> None:
    """Self-check before sending a request: method name, required parameters, extra parameters."""
    spec = shell_methods().get(method)
    if spec is None:
        raise ContractError(f"未知的 shell 方法：{method}（契约里没有）")

    required = set(spec.get("required", []))
    optional = set(spec.get("optional", []))
    allowed = required | optional

    missing = required - set(params)
    if missing:
        raise ContractError(f"{method} 缺少必填参数：{', '.join(sorted(missing))}")

    unknown = set(params) - allowed
    if unknown:
        raise ContractError(
            f"{method} 出现契约未声明的参数：{', '.join(sorted(unknown))}（允许：{', '.join(sorted(allowed)) or '无'}）"
        )


def result_keys(method: str) -> set[str]:
    """Declare the result fields of this method (used by the kernel side for completeness assertions/tests)."""
    spec = shell_methods().get(method) or {}
    return set(spec.get("result", []))


def _roots() -> list[Path]:
    here = Path(__file__).resolve()
    # beecode/contract.py → two levels up is the extension root (installed mode) or the repo root (dev mode)
    roots = [here.parent.parent]
    cwd = Path.cwd()
    if cwd not in roots:
        roots.append(cwd)
    return roots


def _check_version(data: dict[str, Any]) -> None:
    version = data.get("version")
    if version != ipc.PROTOCOL_VERSION:
        raise ContractError(f"契约版本 {version} 与 ipc.PROTOCOL_VERSION {ipc.PROTOCOL_VERSION} 不一致")
