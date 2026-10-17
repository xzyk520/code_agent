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


class ShellClient:
    """所有 `shell.*` RPC 的薄封装。方法名与 README §4.5.1 一一对应。"""

    def __init__(self, peer: JsonRpcPeer) -> None:
        self._peer = peer

    # ───────────────────────── 读 ─────────────────────────

    async def read_file(self, path: str, start_line: int | None = None, end_line: int | None = None) -> ReadResult:
        payload: dict[str, Any] = {"path": path}
        if start_line is not None:
            payload["startLine"] = start_line
        if end_line is not None:
            payload["endLine"] = end_line
        result = await self._peer.request("fs.read", payload)
        return ReadResult(
            text=result.get("text", ""),
            version=int(result.get("version", 0)),
            total_lines=int(result.get("totalLines", 0)),
        )

    async def list_files(self, glob: str = "**/*", exclude: str | None = None, max_results: int = 5000) -> list[str]:
        payload: dict[str, Any] = {"glob": glob, "maxResults": max_results}
        if exclude is not None:
            payload["exclude"] = exclude
        result = await self._peer.request("fs.list", payload)
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
        result = await self._peer.request("search.grep", payload)
        return [GrepHit(**hit) for hit in result.get("hits", [])]

    async def outline(self, path: str) -> list[Symbol]:
        result = await self._peer.request("symbols.outline", {"path": path})
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
        result = await self._peer.request("diagnostics.get", payload)
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
        result = await self._peer.request("edit.apply", payload, timeout=60.0)
        return ApplyResult(
            applied=bool(result.get("applied")),
            version=result.get("version"),
            conflict=bool(result.get("conflict", False)),
            message=result.get("message"),
        )

    async def checkpoint(self, label: str | None = None) -> str:
        result = await self._peer.request("checkpoint.create", {"label": label or ""})
        return str(result.get("id", ""))

    async def restore_checkpoint(self, checkpoint_id: str, scope: str = "files") -> list[str]:
        result = await self._peer.request("checkpoint.restore", {"id": checkpoint_id, "scope": scope}, timeout=120.0)
        return list(result.get("restored", []))

    # ───────────────────────── UI ─────────────────────────

    async def open_diff(self, path: str, base_text: str, title: str | None = None) -> bool:
        result = await self._peer.request("diff.open", {"path": path, "baseText": base_text, "title": title or ""})
        return bool(result.get("opened"))

    async def confirm(self, question: str, options: list[dict[str, str]], detail: str | None = None) -> str | None:
        result = await self._peer.request(
            "confirm.ask",
            {"question": question, "detail": detail or "", "options": options},
            timeout=300.0,
        )
        return result.get("choice")

    async def get_secret(self, key: str) -> str | None:
        result = await self._peer.request("secrets.get", {"key": key})
        return result.get("value")
