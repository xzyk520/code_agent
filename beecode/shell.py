"""Kernel-side wrapper for shell capabilities (kernel → shell).

The kernel **cannot** read or write files, look up symbols, or apply diffs directly — all of
that lives in the TS shell. This module wraps each RPC as a method, and the agent logic only
talks to this class.

Usage:
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
    version: int | None
    total_lines: int | None
    start_line: int
    end_line: int
    truncated: bool

    @property
    def line_count(self) -> int:
        return self.end_line - self.start_line + 1


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
    count: int | None = None
    context: str | None = None


@dataclass(slots=True)
class Symbol:
    name: str
    kind: str
    start_line: int
    end_line: int
    container: str | None = None
    #: Position of the identifier itself (1-based); `references` should use this, since the range start line may fall inside a comment
    selection_line: int | None = None
    selection_column: int | None = None


@dataclass(slots=True)
class RunResult:
    exit_code: int | None
    stdout: str
    stderr: str
    truncated: bool
    duration_ms: int
    sandbox: str
    killed: bool
    job_id: str | None = None
    status: str = "exited"
    elapsed_ms: int = 0
    progress: str | None = None
    output_age_ms: int | None = None
    backgrounded: bool = False
    has_new_output: bool = False
    no_new_output: bool = False
    notice: str | None = None

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.killed


@dataclass(slots=True)
class Diagnostic:
    path: str
    severity: str
    message: str
    start_line: int
    end_line: int
    source: str | None = None
    code: str | None = None
    start_column: int | None = None
    end_column: int | None = None


def _int_or_none(mapping: object, key: str) -> int | None:
    if not isinstance(mapping, dict):
        return None
    value = mapping.get(key)
    return int(value) if isinstance(value, (int, float)) else None

def turn_label(turn: int, note: str = "") -> str:
    """Uniform checkpoint label format: `turn-3` / `turn-3: apply parseConfig changes`.

    Why this is needed: once the shadow repository exceeds retention it compacts history
    (rewriting the parent chain), and compaction preserves commit messages. As long as the
    label itself is readable, `list()` still shows `turn-3` instead of a string of hashes.

    Usage:
        await shell.checkpoint(turn_label(turn=3, note="apply parseConfig changes"))
    """
    return f"turn-{turn}: {note}" if note else f"turn-{turn}"


class ShellClient:
    """Shell-side method wrapper.

    `role` is sent with `run` / `edit.apply` — subagents automatically get a stricter policy,
    so the tool layer does not need to check it again.
    """
    """Thin wrapper around every `shell.*` RPC. Method names correspond one-to-one with README §4.5.1.

    Every request goes through `contract.check_shell_call()`: a misspelled method name, a
    missing required parameter, or an extra field not declared in the contract raises
    `ContractError` **before the request is sent**, instead of waiting for a
    `METHOD_NOT_FOUND` response or silently ignoring a parameter.
    """

    #: All wire method names this class can send (checked against the contract by `tests/python/test_contract.py`)
    SHELL_METHODS: frozenset[str] = frozenset(
        {
            "fs.read",
            "fs.list",
            "search.grep",
            "symbols.outline",
            "symbols.search",
            "symbols.references",
            "diagnostics.get",
            "edit.apply",
            "checkpoint.create",
            "checkpoint.restore",
            "diff.open",
            "confirm.ask",
            "secrets.get",
            "run",
        }
    )

    def __init__(self, peer: JsonRpcPeer, role: str = "main") -> None:
        self._peer = peer
        self._role = role

    def with_role(self, role: str) -> "ShellClient":
        """Return a client using the given role (sharing the same peer)."""
        return ShellClient(self._peer, role=role)

    async def _call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30.0) -> Any:
        payload = params or {}
        check_shell_call(method, payload)
        return await self._peer.request(method, payload, timeout=timeout)

    # ───────────────────────── Read ─────────────────────────

    async def read_file(self, path: str, start_line: int | None = None, end_line: int | None = None) -> ReadResult:
        payload: dict[str, Any] = {"path": path, "role": self._role}
        if start_line is not None:
            payload["startLine"] = start_line
        if end_line is not None:
            payload["endLine"] = end_line
        result = await self._call("fs.read", payload)
        version = result.get("version")
        total = result.get("totalLines")
        return ReadResult(
            text=result.get("text", ""),
            version=int(version) if isinstance(version, (int, float)) else None,
            total_lines=int(total) if isinstance(total, (int, float)) else None,
            start_line=int(result.get("startLine", 1)),
            end_line=int(result.get("endLine", 1)),
            truncated=bool(result.get("truncated", False)),
        )

    async def list_files(self, glob: str = "**/*", exclude: str | None = None, max_results: int = 5000) -> list[str]:
        """Return only the path list (use `list_files_result` when you need to know whether it was truncated)."""
        result = await self.list_files_result(glob, exclude=exclude, max_results=max_results)
        return list(result.get("paths", []))

    async def read_symbol(self, path: str, symbol: str) -> ReadResult:
        """Read **one function/class** from a (possibly large) file: locate it with outline, then read the line range.

        Recommended approach, so the model does not have to guess line numbers:
            symbols.outline(path) → find a symbol whose name matches (or a `Container.name` suffix match)
            fs.read(path, start_line, end_line)

        Matching rules: exact equality wins; otherwise match by `.` suffix (`ConfigParser.parse` can be shortened to `parse`).
        """
        symbols = await self.outline(path)
        wanted = symbol.strip()
        if not wanted:
            raise ValueError("symbol cannot be empty")

        exact = [s for s in symbols if s.name == wanted]
        suffix = [s for s in symbols if s.name != wanted and wanted.endswith("." + s.name)]
        candidates = exact or suffix
        if not candidates:
            names = ", ".join(sorted({s.name for s in symbols})[:20]) or "(this file has no symbol information)"
            raise ValueError(f"Cannot find symbol in {path}: {symbol}; candidates: {names}")

        target = candidates[0]
        return await self.read_file(path, target.start_line, target.end_line)
    async def list_files_result(
        self, glob: str = "**/*", exclude: str | None = None, max_results: int = 5000
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"glob": glob, "maxResults": max_results}
        if exclude is not None:
            payload["exclude"] = exclude
        return dict(await self._call("fs.list", payload))

    async def grep(
        self,
        query: str,
        *,
        regex: bool = False,
        glob: str | None = None,
        context_lines: int = 0,
        max_results: int = 200,
        case_sensitive: bool = False,
        exclude: str | None = None,
    ) -> list[GrepHit]:
        payload: dict[str, Any] = {
            "query": query,
            "regex": regex,
            "contextLines": context_lines,
            "maxResults": max_results,
            "caseSensitive": case_sensitive,
        }
        if glob:
            payload["glob"] = glob
        if exclude:
            payload["exclude"] = exclude
        result = await self._call("search.grep", payload)
        return [GrepHit(**hit) for hit in result.get("hits", [])]

    async def grep_files(
        self,
        query: str,
        *,
        regex: bool = False,
        glob: str | None = None,
        max_results: int = 200,
        case_sensitive: bool = False,
        exclude: str | None = None,
    ) -> dict[str, Any]:
        """Recall mode: return only "which files matched and how many times each" as `{files, truncated}`.

        Use it in the two-step "find candidate files first, then read closely" flow — it saves
        an order of magnitude of tokens compared with `grep()`.
        """
        payload: dict[str, Any] = {
            "query": query,
            "regex": regex,
            "maxResults": max_results,
            "filesOnly": True,
            "caseSensitive": case_sensitive,
        }
        if glob:
            payload["glob"] = glob
        if exclude:
            payload["exclude"] = exclude
        return dict(await self._call("search.grep", payload))

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
                    selection_line=_int_or_none(item.get("selection"), "startLine"),
                    selection_column=_int_or_none(item.get("selection"), "startColumn"),
                )
            )
        return symbols

    async def symbols_search(self, query: str, *, max_results: int = 100) -> dict[str, Any]:
        """Find definitions by name across the workspace: `{symbols, source, truncated}`.

        `source` can be one of three values:
          - `"lsp"`: the language server's workspace/symbol index (most accurate and fastest)
          - `"fallback"`: without a provider, fall back to "grep for files + outline each one"; **may be incomplete**
          - `"none"`: nothing was found

        Each symbol has `path` and `range`, which can be passed directly to `read_symbol` for precise reading.
        """
        return dict(await self._call("symbols.search", {"query": query, "maxResults": max_results}))

    async def symbols_references(
        self, path: str, line: int, *, column: int = 1, max_results: int = 200
    ) -> dict[str, Any]:
        """All references at a position (usually the line containing the symbol name): `{locations, truncated}`.

        `line` can be the `start_line` returned by `outline()`.
        """
        payload = {"path": path, "line": line, "column": column, "maxResults": max_results}
        return dict(await self._call("symbols.references", payload))
    async def references_of_symbol(self, path: str, symbol: str, *, max_results: int = 200) -> dict[str, Any]:
        """Find a symbol with outline first, then query references using the **identifier position** (selection).

        Do not use `range.start_line`: it includes leading comments/docstrings, and positions
        that fall inside comments often cannot be resolved by reference providers, producing
        empty results.
        """
        wanted = symbol.strip()
        if not wanted:
            raise ValueError("symbol cannot be empty")
        symbols = await self.outline(path)
        exact = [s for s in symbols if s.name == wanted]
        suffix = [s for s in symbols if s.name != wanted and wanted.endswith("." + s.name)]
        candidates = exact or suffix
        if not candidates:
            raise ValueError(f"Cannot find symbol in {path}: {symbol}")
        target = candidates[0]
        line = target.selection_line or target.start_line
        column = target.selection_column or 1
        return await self.symbols_references(path, line, column=column, max_results=max_results)
    async def diagnostics(
        self,
        path: str | None = None,
        *,
        min_severity: str | None = None,
        max_items: int | None = None,
        include_ignored: bool = False,
    ) -> list[Diagnostic]:
        """Read LSP diagnostics (errors sorted first, at most 200 by default).

        ⚠️ **Empty diagnostics ≠ no problems**: the shell can only return diagnostics for files
        that the language server has analyzed, so just after a window opens only a few files
        may have values. Debugger prompts must state this.

        Parameters:
            path: only look at this file; omit for everything
            min_severity: `"error"` / `"warning"` / `"info"` / `"hint"`; items below it are filtered out
            max_items: maximum number of items to return (default 200, hard cap 2000)
            include_ignored: whether to include files in node_modules/.git/.gitignore
        """
        result = await self.diagnostics_result(
            path, min_severity=min_severity, max_items=max_items, include_ignored=include_ignored
        )
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
                    code=item.get("code"),
                    start_column=rng.get("startColumn"),
                    end_column=rng.get("endColumn"),
                )
            )
        return out

    async def diagnostics_result(
        self,
        path: str | None = None,
        *,
        min_severity: str | None = None,
        max_items: int | None = None,
        include_ignored: bool = False,
    ) -> dict[str, Any]:
        """Same as above, but returns `{items, total, truncated}` — use when you need to know whether it was truncated."""
        payload: dict[str, Any] = {"includeIgnored": include_ignored}
        if path:
            payload["path"] = path
        if min_severity:
            payload["minSeverity"] = min_severity
        if max_items is not None:
            payload["maxItems"] = max_items
        return dict(await self._call("diagnostics.get", payload))

    # ───────────────────────── Write ─────────────────────────

    async def apply_edit(
        self,
        path: str,
        new_text: str,
        *,
        expected_version: int | None = None,
        reason: str | None = None,
        op: str = "write",
    ) -> ApplyResult:
        payload: dict[str, Any] = {"path": path, "newText": new_text, "op": op, "role": self._role}
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
        """Create a checkpoint and return its commit id; returns an empty string when `skipped=True` (see `checkpoint_result`).

        Lightweight mode: pass `paths` to snapshot only those files, so large repositories do
        not need a whole-tree snapshot.

        ⚠️ **An id is not a permanent identifier**: once the shadow repository exceeds
        `retention + 10` snapshots it compacts history (rewriting the parent chain with
        `commit-tree`), at which point **every commit hash changes**, including the one just
        returned. Therefore:

        - Use the returned id only "within the same batch of creates" (typically: snapshot at
          the start of the turn, restore at the end of the turn);
        - **Do not remember it across sessions or turns**; for a long-lived reference use
          `label` (such as `turn-3`) and have the shell list checkpoints again to resolve it
          into the current id before use;
        - Passing an expired id to `restore` fails with `unknown revision`; that is expected.
        """
        payload: dict[str, Any] = {"label": label or ""}
        if paths:
            payload["paths"] = list(paths)
        result = await self._call("checkpoint.create", payload)
        return str(result.get("id", ""))

    async def checkpoint_result(self, label: str | None = None, paths: list[str] | None = None) -> dict[str, Any]:
        """Same as above, but returns the full result (including `skipped` / `reason`) — use when you need to distinguish "not done" from "done".

        Returned fields: `{id, files, skipped?, reason?}`. `skipped=True` means no checkpoint
        was created this time (the setting is off / there is no workspace); in that case `id`
        is an empty string, and **do not** pass it to restore as a valid id.
        """
        payload: dict[str, Any] = {"label": label or ""}
        if paths:
            payload["paths"] = list(paths)
        return dict(await self._call("checkpoint.create", payload))

    async def restore_checkpoint(self, checkpoint_id: str) -> list[str]:
        """Restore files only; task/session state is reset by the kernel itself.

        ⚠️ The incoming `checkpoint_id` must be a hash that **still exists right now**: after
        history compaction all old ids become invalid (`unknown revision`). To "restore to a
        historical point", first locate it by label/timestamp, then ask the shell to list
        checkpoints again and obtain the current id; do not cache the previous hash.
        """
        result = await self._call("checkpoint.restore", {"id": checkpoint_id}, timeout=120.0)
        return list(result.get("restored", []))

    # ───────────────────────── UI ─────────────────────────

    async def open_diff(self, path: str, base_text: str, title: str | None = None) -> bool:
        result = await self._call("diff.open", {"path": path, "baseText": base_text, "title": title or ""})
        return bool(result.get("opened"))

    async def run(
        self,
        command: str,
        *,
        cwd: str | None = None,
        yield_ms: int = 60_000,
        rpc_timeout: float = 120.0,
        sandbox: str = "sandbox-readonly",
        justification: str = "",
    ) -> RunResult:
        """Run a command inside the workspace.

        Privilege levels from lowest to highest: `sandbox-readonly` (default, Docker read-only) →
        `sandbox` (Docker with a writable workspace) → `sandbox-network` (Docker + network) →
        `host` (the real system). Every elevation requires user approval; non-default levels
        require a `justification`.

        ⚠️ This is an operation **with side effects**: the shell first makes a permission
        decision (mode + rules + workspace trust), and prompts for confirmation when needed.
        Do not use it for read-only probing — use `read_file` to read files.
        """
        payload: dict[str, Any] = {
            "command": command,
            "role": self._role,
            "sandbox": sandbox,
            "justification": justification,
        }
        if cwd:
            payload["cwd"] = cwd
        payload["yieldMs"] = max(1000, min(int(yield_ms), 300_000))
        result = await self._call("run", payload, timeout=max(rpc_timeout, payload["yieldMs"] / 1000 + 60))
        return _run_result(result)

    async def wait(self, job_id: str, *, yield_ms: int | None = None) -> RunResult:
        """Keep waiting on a command that is still running; previously read output is not returned again."""
        wait_ms = 60_000 if yield_ms is None else max(1000, min(int(yield_ms), 300_000))
        payload: dict[str, Any] = {"jobId": job_id}
        if yield_ms is not None:
            payload["yieldMs"] = wait_ms
        result = await self._call("command.wait", payload, timeout=max(120.0, wait_ms / 1000 + 60))
        return _run_result(result)

    async def list_jobs(self) -> list[dict[str, Any]]:
        result = await self._call("command.list", {})
        jobs = result.get("jobs")
        return list(jobs) if isinstance(jobs, list) else []

    async def terminate(self, job_id: str) -> RunResult:
        result = await self._call("command.terminate", {"jobId": job_id}, timeout=30.0)
        return _run_result(result)

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


def _run_result(result: dict[str, Any]) -> RunResult:
    raw_exit = result.get("exitCode")
    return RunResult(
        exit_code=int(raw_exit) if raw_exit is not None else None,
        stdout=str(result.get("stdout", "")),
        stderr=str(result.get("stderr", "")),
        truncated=bool(result.get("truncated", False)),
        duration_ms=int(result.get("durationMs", 0)),
        sandbox=str(result.get("sandbox", "none")),
        killed=bool(result.get("killed", False)),
        job_id=str(result["jobId"]) if result.get("jobId") else None,
        status=str(result.get("status") or "exited"),
        elapsed_ms=int(result.get("elapsedMs") or result.get("durationMs") or 0),
        progress=str(result["progress"]) if result.get("progress") else None,
        output_age_ms=int(result["outputAgeMs"]) if result.get("outputAgeMs") is not None else None,
        backgrounded=bool(result.get("backgrounded", False)),
        has_new_output=bool(result.get("hasNewOutput", False)),
        no_new_output=bool(result.get("noNewOutput", False)),
        notice=str(result["notice"]) if result.get("notice") else None,
    )
