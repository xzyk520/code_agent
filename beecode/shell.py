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
    #: 标识符本身的位置（1-based）；`references` 要用它，range 起始行可能落在注释里
    selection_line: int | None = None
    selection_column: int | None = None


@dataclass(slots=True)
class RunResult:
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool
    duration_ms: int
    sandbox: str
    killed: bool

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
    """统一的检查点标签格式：`turn-3` / `turn-3: 应用 parseConfig 改动`。

    为什么需要：影子仓库超过 retention 会压缩历史（重写父链），压缩保留 commit message，
    所以只要标签本身可读，压缩后 `list()` 里依然是 `turn-3` 而不是一串哈希。

    用法：
        await shell.checkpoint(turn_label(turn=3, note="应用 parseConfig 改动"))
    """
    return f"turn-{turn}: {note}" if note else f"turn-{turn}"


class ShellClient:
    """壳侧方法封装。

    `role` 会随 `run` / `edit.apply` 一起发给壳——子代理自动获得更严的策略，
    不需要在工具层重复判断。
    """
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
        """返回一个使用指定角色的客户端（共享同一个 peer）。"""
        return ShellClient(self._peer, role=role)

    async def _call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30.0) -> Any:
        payload = params or {}
        check_shell_call(method, payload)
        return await self._peer.request(method, payload, timeout=timeout)

    # ───────────────────────── 读 ─────────────────────────

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
        """只返回路径列表（需要知道是否被截断时用 `list_files_result`）。"""
        result = await self.list_files_result(glob, exclude=exclude, max_results=max_results)
        return list(result.get("paths", []))

    async def read_symbol(self, path: str, symbol: str) -> ReadResult:
        """在（可能很大的）文件里读**一个函数/类**：先 outline 定位，再按行范围读。

        推荐姿势，避免让模型猜行号：
            symbols.outline(path) → 找到 name 匹配（或 `Container.name` 后缀匹配）的符号
            fs.read(path, start_line, end_line)

        匹配规则：完全相等优先；否则按 `.` 后缀匹配（`ConfigParser.parse` 可简写 `parse`）。
        """
        symbols = await self.outline(path)
        wanted = symbol.strip()
        if not wanted:
            raise ValueError("symbol 不能为空")

        exact = [s for s in symbols if s.name == wanted]
        suffix = [s for s in symbols if s.name != wanted and wanted.endswith("." + s.name)]
        candidates = exact or suffix
        if not candidates:
            names = ", ".join(sorted({s.name for s in symbols})[:20]) or "（该文件没有符号信息）"
            raise ValueError(f"在 {path} 里找不到符号 {symbol}；候选：{names}")

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
        """召回模式：只返回「哪些文件命中、各几次」`{files, truncated}`。

        用在"先找候选文件、再精读"的两步流程里——比 `grep()` 省一个数量级的 token。
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
        """全工作区按名字找定义：`{symbols, source, truncated}`。

        `source` 三种取值：
          - `"lsp"`：语言服务的 workspace/symbol 索引（最准、最快）
          - `"fallback"`：没有 provider 时用「grep 找文件 + 逐个 outline」兜底，**可能不全**
          - `"none"`：什么都没找到

        每个符号带 `path` 与 `range`，可以直接喂给 `read_symbol` 精确阅读。
        """
        return dict(await self._call("symbols.search", {"query": query, "maxResults": max_results}))

    async def symbols_references(
        self, path: str, line: int, *, column: int = 1, max_results: int = 200
    ) -> dict[str, Any]:
        """某个位置（通常是符号名那一行）的所有引用：`{locations, truncated}`。

        `line` 用 `outline()` 拿到的 `start_line` 即可。
        """
        payload = {"path": path, "line": line, "column": column, "maxResults": max_results}
        return dict(await self._call("symbols.references", payload))
    async def references_of_symbol(self, path: str, symbol: str, *, max_results: int = 200) -> dict[str, Any]:
        """先 outline 找到符号，再用**标识符位置**（selection）查引用。

        不要用 `range.start_line`：它包含前导注释/docstring，落在注释里的位置
        参考提供者常常解析不到符号，会返回空结果。
        """
        wanted = symbol.strip()
        if not wanted:
            raise ValueError("symbol 不能为空")
        symbols = await self.outline(path)
        exact = [s for s in symbols if s.name == wanted]
        suffix = [s for s in symbols if s.name != wanted and wanted.endswith("." + s.name)]
        candidates = exact or suffix
        if not candidates:
            raise ValueError(f"在 {path} 里找不到符号 {symbol}")
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
        """读取 LSP 诊断（error 优先排序、默认最多 200 条）。

        ⚠️ **诊断为空 ≠ 代码没问题**：壳只能返回「已被语言服务分析过」的文件的诊断，
        刚打开窗口时可能只有少数文件有值。写 Debugger 提示词时要说明这一点。

        参数：
            path: 只看这个文件；省略 = 全量
            min_severity: `"error"` / `"warning"` / `"info"` / `"hint"`，低于它的被过滤
            max_items: 最多返回多少条（默认 200，硬上限 2000）
            include_ignored: 是否包含 node_modules/.git/.gitignore 里的文件
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
        """同上，但返回 `{items, total, truncated}` —— 需要知道「是否被截断」时用。"""
        payload: dict[str, Any] = {"includeIgnored": include_ignored}
        if path:
            payload["path"] = path
        if min_severity:
            payload["minSeverity"] = min_severity
        if max_items is not None:
            payload["maxItems"] = max_items
        return dict(await self._call("diagnostics.get", payload))

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

    async def run(
        self,
        command: str,
        *,
        cwd: str | None = None,
        timeout_ms: int | None = None,
        rpc_timeout: float = 600.0,
        sandbox: str = "sandbox-readonly",
        justification: str = "",
    ) -> RunResult:
        """在工作区内执行命令。

        权限从低到高：`sandbox-readonly`（默认，Docker 只读）→
        `sandbox`（Docker 工作区可写）→ `sandbox-network`（Docker + 网络）→
        `host`（真实系统）。每一级升级都需要用户审批；非默认级必须 `justification`。

        ⚠️ 这是**有副作用**的操作：壳会先做权限判定（模式 + 规则 + 工作区信任），
        需要确认时会弹窗。不要用它做只读探测——读文件用 `read_file`。
        """
        payload: dict[str, Any] = {
            "command": command,
            "role": self._role,
            "sandbox": sandbox,
            "justification": justification,
        }
        if cwd:
            payload["cwd"] = cwd
        if timeout_ms is not None:
            payload["timeoutMs"] = timeout_ms
        result = await self._call("run", payload, timeout=rpc_timeout)
        return RunResult(
            exit_code=int(result.get("exitCode", -1)),
            stdout=result.get("stdout", ""),
            stderr=result.get("stderr", ""),
            truncated=bool(result.get("truncated", False)),
            duration_ms=int(result.get("durationMs", 0)),
            sandbox=str(result.get("sandbox", "none")),
            killed=bool(result.get("killed", False)),
        )

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
