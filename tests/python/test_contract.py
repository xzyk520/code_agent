"""协议契约与内核侧封装的对账测试。

跑法：`pip install -e ".[dev]"` 之后 `pytest -q`。
这几个测试很便宜，但能挡住最贵的一类 bug：**两侧方法名/参数名悄悄漂移**。
"""

from __future__ import annotations

import pytest

from beecode import contract, ipc
from beecode.contract import ContractError
from beecode.shell import ShellClient


def test_contract_version_matches_protocol() -> None:
    """契约版本必须等于 ipc.PROTOCOL_VERSION，否则握手就该失败。"""
    assert contract.contract()["version"] == ipc.PROTOCOL_VERSION


def test_shell_client_methods_match_contract() -> None:
    """ShellClient 会发出的方法，必须与契约声明的 shellMethods 完全一致。"""
    assert set(ShellClient.SHELL_METHODS) == set(contract.shell_methods())


def test_every_method_declares_result_keys() -> None:
    """每个方法都要声明返回字段——否则内核侧取值时只能靠记忆。"""
    for method, spec in contract.shell_methods().items():
        assert spec.get("result"), f"{method} 缺少 result 声明"


def test_check_shell_call_rejects_unknown_method() -> None:
    with pytest.raises(ContractError):
        contract.check_shell_call("fs.reed", {"path": "a.ts"})  # 故意的拼写错误


def test_check_shell_call_rejects_missing_required() -> None:
    with pytest.raises(ContractError):
        contract.check_shell_call("fs.read", {})


def test_check_shell_call_rejects_unknown_param() -> None:
    with pytest.raises(ContractError):
        contract.check_shell_call("fs.read", {"path": "a.ts", "pathh": "typo"})


def test_check_shell_call_accepts_valid_payload() -> None:
    contract.check_shell_call("edit.apply", {"path": "a.ts", "newText": "x", "reason": "r"})
    contract.check_shell_call("secrets.get", {"key": "beeCode.apiKey.default"})
