"""协议契约的运行时校验（与 `protocol/contract.json` 对账）。

为什么需要：`src/protocol.ts` 的接口是 TypeScript 类型，编译后就消失了，
Python 侧完全看不到；反过来 TS 也看不到 Python。两侧的「方法名/参数名」
只能靠一份**共同真相**——就是 `protocol/contract.json`。

校验点：
  - 每次发 RPC 前：方法名必须在契约里、必填参数齐全、不允许拼错的多余参数
  - 启动时（可选）：契约版本必须等于 `ipc.PROTOCOL_VERSION`
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import ipc

CONTRACT_RELATIVE = Path("protocol") / "contract.json"


class ContractError(RuntimeError):
    """契约被违反（拼错方法名/参数名、缺必填项、版本不一致）"""


@lru_cache(maxsize=1)
def contract() -> dict[str, Any]:
    """加载契约（进程内缓存）。找不到文件时抛 ContractError —— 拿不到契约就不能保证协议正确。"""
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
    """发请求前的自检：方法名、必填参数、多余参数。"""
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
    """声明该方法的返回字段（供内核侧做完整性断言/测试用）。"""
    spec = shell_methods().get(method) or {}
    return set(spec.get("result", []))


def _roots() -> list[Path]:
    here = Path(__file__).resolve()
    # beecode/contract.py → 上两级即扩展根（安装模式）或仓库根（开发模式）
    roots = [here.parent.parent]
    cwd = Path.cwd()
    if cwd not in roots:
        roots.append(cwd)
    return roots


def _check_version(data: dict[str, Any]) -> None:
    version = data.get("version")
    if version != ipc.PROTOCOL_VERSION:
        raise ContractError(f"契约版本 {version} 与 ipc.PROTOCOL_VERSION {ipc.PROTOCOL_VERSION} 不一致")
