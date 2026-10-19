"""壳能力的内核侧封装（内核 → 壳）。

内核**不能**直接读写文件、拿符号、落 diff —— 那些都在 TS 壳里。
这里把每个 RPC 包成一个方法，agent 逻辑只跟这个类打交道。

用法：
    shell = ShellClient(peer, workspace_root=Path("."))
    doc = await shell.read_file("src/config/parse.ts")
    await shell.apply_edit("src/config/parse.ts", new_text=doc.text.replace("a", "b"), expected_version=doc.version)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .contract import check_shell_call
from .ipc import JsonRpcPeer


@dataclass(slots=True)
class ReadResult:
    text: str
    version: int
    total_lines: int


@dataclass(slots=True)
class ApplyResult:
    applied: bool
    version: int | None = None
    conflict: bool = False
    message: str | None = None


@dataclass(slots=True)
class GrepHit:
    path: str
    line: int
    col: int
    text: str


@dataclass(slots=True)
class Symbol:
    name: str
    kind: str
    start_line: int
    end_line: int
    container: str | None = None


@dataclass(slots=True)
class Diagnostic:
    path: str
    severity: str
    message: str
    start_line: int
    end_line: int
    source: str | None = None


def turn_label(turn: int, note: str = "") -> str:
    """统一的检查点标签格式：`turn-3` / `turn-3: 应用 parseConfig 改动`。

    为什么需要：影子仓库超过 retention 会压缩历史（重写父链），压缩保留 commit message，
    所以只要标签本身可读，压缩后 `list()` 里依然是 `turn-3` 而不是一串哈希。

    用法：
        await shell.checkpoint(turn_label(turn=3, note="应用 parseConfig 改动"))
    """
    return f"turn-{turn}: {note}" if note else f"turn-{turn}"


class ShellClient:
    """所有 `shell.*` RPC 的薄封装。方法名与 README §4.5.1 一一对应。

    每个请求都过 `contract.check_shell_call()`：方法名拼错、必填参数漏了、
    多传了契约没声明的字段，都会在**发出去之前**抛 `ContractError`，
    而不是等壳回一个 `METHOD_NOT_FOUND` 或静默忽略参数。
    """

    #: 本类会发出的全部线缆方法名（供 `tests/python/test_contract.py` 与契约对账）
    SHELL_METHODS: frozenset[str] = frozenset(
        {
            "fs.read",
            "fs.list",
            "search.grep",
            "symbols.outline",
            "diagnostics.get",
            "edit.apply",
            "checkpoint.create",
            "checkpoint.restore",
            "diff.open",
            "confirm.ask",
            "secrets.get",
        }
    )

    def __init__(self, peer: JsonRpcPeer) -> None:
        self._peer = peer

    async def _call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30.0) -> Any:
        payload = params or {}
        check_shell_call(method, payload)
        return await self._peer.request(method, payload, timeout=timeout)

    # ───────────────────────── 读 ─────────────────────────

    async def read_file(self, path: str, start_line: int | None = None, end_line: int | None = None) -> ReadResult:
        payload: dict[str, Any] = {"path": path}
        if start_line is not None:
            payload["startLine"] = start_line
        if end_line is not None:
            payload["endLine"] = end_line
        result = await self._call("fs.read", payload)
        return ReadResult(
            text=result.get("text", ""),
            version=int(result.get("version", 0)),
            total_lines=int(result.get("totalLines", 0)),
        )

    async def list_files(self, glob: str = "**/*", exclude: str | None = None, max_results: int = 5000) -> list[str]:
        payload: dict[str, Any] = {"glob": glob, "maxResults": max_results}
        if exclude is not None:
            payload["exclude"] = exclude
        result = await self._call("fs.list", payload)
        return list(result.get("paths", []))

    async def grep(
        self,
        query: str,
        *,
        regex: bool = False,
        glob: str | None = None,
        context_lines: int = 0,
        max_results: int = 200,
    ) -> list[GrepHit]:
        payload: dict[str, Any] = {
            "query": query,
            "regex": regex,
            "contextLines": context_lines,
            "maxResults": max_results,
        }
        if glob:
            payload["glob"] = glob
        result = await self._call("search.grep", payload)
        return [GrepHit(**hit) for hit in result.get("hits", [])]

    async def outline(self, path: str) -> list[Symbol]:
        result = await self._call("symbols.outline", {"path": path})
        symbols: list[Symbol] = []
        for item in result.get("symbols", []):
            rng = item.get("range", {})
            symbols.append(
                Symbol(
                    name=item.get("name", ""),
                    kind=item.get("kind", ""),
                    start_line=int(rng.get("startLine", 1)),
                    end_line=int(rng.get("endLine", 1)),
                    container=item.get("container"),
                )
            )
        return symbols

    async def diagnostics(self, path: str | None = None) -> list[Diagnostic]:
        payload = {"path": path} if path else {}
        result = await self._call("diagnostics.get", payload)
        out: list[Diagnostic] = []
        for item in result.get("items", []):
            rng = item.get("range", {})
            out.append(
                Diagnostic(
                    path=item.get("path", ""),
                    severity=item.get("severity", "error"),
                    message=item.get("message", ""),
                    start_line=int(rng.get("startLine", 1)),
                    end_line=int(rng.get("endLine", 1)),
                    source=item.get("source"),
                )
            )
        return out

    # ───────────────────────── 写 ─────────────────────────

    async def apply_edit(
        self,
        path: str,
        new_text: str,
        *,
        expected_version: int | None = None,
        reason: str | None = None,
        op: str = "write",
    ) -> ApplyResult:
        payload: dict[str, Any] = {"path": path, "newText": new_text, "op": op}
        if expected_version is not None:
            payload["expectedVersion"] = expected_version
        if reason:
            payload["reason"] = reason
        result = await self._call("edit.apply", payload, timeout=60.0)
        return ApplyResult(
            applied=bool(result.get("applied")),
            version=result.get("version"),
            conflict=bool(result.get("conflict", False)),
            message=result.get("message"),
        )

    async def checkpoint(self, label: str | None = None, paths: list[str] | None = None) -> str:
        """建一个检查点，返回 commit id；`skipped=True` 时返回空串（见 `checkpoint_result`）。

        轻量模式：传 `paths` 只快照这些文件，大仓库不必全树快照。

        ⚠️ **id 不是永久标识**：影子仓库超过 `retention + 10` 个快照时会压缩历史
        （用 `commit-tree` 重写父链），届时**所有 commit 的哈希都会变**，连刚返回的
        这个也可能失效。所以：

        - 只在「同一批 create 之间」使用返回的 id（典型：本轮开始时快照，本轮结束时恢复）；
        - **不要跨会话/跨多轮记住它**；需要长期引用请用 `label`（如 `turn-3`），
          用之前先让壳重新列出检查点解析成当前 id；
        - 拿到失效 id 时 `restore` 会以 `unknown revision` 失败，这是预期行为。
        """
        payload: dict[str, Any] = {"label": label or ""}
        if paths:
            payload["paths"] = list(paths)
        result = await self._call("checkpoint.create", payload)
        return str(result.get("id", ""))

    async def checkpoint_result(self, label: str | None = None, paths: list[str] | None = None) -> dict[str, Any]:
        """同上，但返回完整结果（含 `skipped` / `reason`）——需要区分「没做」和「做了」时用。

        返回字段：`{id, files, skipped?, reason?}`。`skipped=True` 表示这次没建检查点
        （设置关闭 / 没有工作区），此时 `id` 为空串，**不要**把它当成有效 id 传给 restore。
        """
        payload: dict[str, Any] = {"label": label or ""}
        if paths:
            payload["paths"] = list(paths)
        return dict(await self._call("checkpoint.create", payload))

    async def restore_checkpoint(self, checkpoint_id: str) -> list[str]:
        """只恢复文件；任务/会话状态由内核自己重置。

        ⚠️ 传进来的 `checkpoint_id` 必须是**当前仍存在**的哈希：历史压缩后旧 id 全部失效
        （`unknown revision`）。需要「恢复到某个历史点」时，应先用 label/时间戳定位、
        再通过壳重新列出检查点拿到当前 id，而不是缓存上次的哈希。
        """
        result = await self._call("checkpoint.restore", {"id": checkpoint_id}, timeout=120.0)
        return list(result.get("restored", []))

    # ───────────────────────── UI ─────────────────────────

    async def open_diff(self, path: str, base_text: str, title: str | None = None) -> bool:
        result = await self._call("diff.open", {"path": path, "baseText": base_text, "title": title or ""})
        return bool(result.get("opened"))

    async def confirm(self, question: str, options: list[dict[str, str]], detail: str | None = None) -> str | None:
        result = await self._call(
            "confirm.ask",
            {"question": question, "detail": detail or "", "options": options},
            timeout=300.0,
        )
        return result.get("choice")

    async def get_secret(self, key: str) -> str | None:
        result = await self._call("secrets.get", {"key": key})
        return result.get("value")
