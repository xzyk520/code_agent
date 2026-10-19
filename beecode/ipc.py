"""壳 ↔ 内核的传输层（JSON-RPC 2.0 over stdio / NDJSON）。

这一层是**协议骨架**，与 agent 逻辑无关：循环、分发、取消、请求超时。
业务处理函数由 `__main__.py` 注册。

对应 TS 侧：`src/rpc/client.ts`（壳作为服务端）与 `src/protocol.ts`（类型）。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import sys
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

PROTOCOL_VERSION = 2

# ---------------------------------------------------------------------------
# 错误码（与 src/protocol.ts 的 RpcError 保持一致）
# ---------------------------------------------------------------------------
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
SHELL_ERROR = -32000
SIG_VERSION_MISMATCH = -32010
SIG_CONFLICT = -32011
SIG_NOT_FOUND = -32012
SIG_DENIED = -32013


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


@dataclass
class RequestContext:
    """一次壳 → 内核请求的上下文。"""

    id: int
    method: str
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)

    def throw_if_cancelled(self) -> None:
        if self.cancelled.is_set():
            raise asyncio.CancelledError("request cancelled")


Handler = Callable[[dict[str, Any], RequestContext], Any | Awaitable[Any]]


class JsonRpcPeer:
    """stdin/stdout 上的 NDJSON 对端。

    两个方向都要支持：
      - 壳 → 内核：本类负责**分发**到注册的 handler
      - 内核 → 壳：本类负责**发请求**并等待响应（`request()`），对应 `shell.py`
    """

    def __init__(
        self,
        reader: Any | None = None,
        writer: Any | None = None,
    ) -> None:
        self._reader = reader or sys.stdin
        self._writer = writer or sys.stdout
        self._handlers: dict[str, Handler] = {}
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._write_lock = asyncio.Lock()
        self._closed = False

    # ───────────────────────── 注册与发送 ─────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def notify(self, method: str, params: Any | None = None) -> None:
        """单向通知（无 id，不等回复）。"""
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    async def request(self, method: str, params: Any | None = None, timeout: float = 30.0) -> Any:
        """内核 → 壳的请求，等待响应。超时抛 RpcError。"""
        req_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future
        self._write({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}})
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise RpcError(SHELL_ERROR, f"RPC 超时：{method}（{timeout}s）") from exc
        finally:
            self._pending.pop(req_id, None)

    # ───────────────────────── 主循环 ─────────────────────────

    async def run(self) -> None:
        while not self._closed:
            line = await asyncio.to_thread(self._reader.readline)
            if not line:
                break
            line = line.strip().lstrip("\ufeff")
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self._write_error(None, PARSE_ERROR, "无法解析 JSON")
                continue
            self._dispatch(message)

        # stdin 关闭：取消所有在飞任务后退出
        for task in list(self._tasks.values()):
            task.cancel()
        self._closed = True

    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        has_id = isinstance(message.get("id"), int)

        if "method" not in message:
            # 这是对端（壳）给我们的响应
            self._settle(message)
            return

        if method == "$/cancelRequest":
            params = message.get("params") or {}
            target = params.get("id")
            if isinstance(target, int):
                task = self._tasks.get(target)
                if task is not None:
                    task.cancel()
            return

        if not has_id:
            self._dispatch_notification(method, message.get("params") or {})
            return

        task = asyncio.create_task(self._run_handler(int(message["id"]), method, message.get("params") or {}))
        self._tasks[int(message["id"])] = task
        task.add_done_callback(lambda _t, i=int(message["id"]): self._tasks.pop(i, None))

    def _dispatch_notification(self, method: str, params: dict[str, Any]) -> None:
        handler = self._handlers.get(method)
        if handler is None:
            return
        try:
            result = handler(params, RequestContext(id=0, method=method))
            if inspect.isawaitable(result):
                asyncio.create_task(result)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001 - 通知失败不能拖垮主循环
            pass

    async def _run_handler(self, req_id: int, method: str, params: dict[str, Any]) -> None:
        handler = self._handlers.get(method)
        if handler is None:
            self._write_error(req_id, METHOD_NOT_FOUND, f"未知方法：{method}")
            return

        ctx = RequestContext(id=req_id, method=method)
        try:
            result = handler(params, ctx)
            if inspect.isawaitable(result):
                result = await result
            self._write({"jsonrpc": "2.0", "id": req_id, "result": result if result is not None else {}})
        except asyncio.CancelledError:
            self._write_error(req_id, SHELL_ERROR, "请求已取消")
        except RpcError as exc:
            self._write_error(req_id, exc.code, exc.message, exc.data)
        except Exception as exc:  # noqa: BLE001
            self._write_error(req_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")

    def _settle(self, message: dict[str, Any]) -> None:
        req_id = message.get("id")
        if not isinstance(req_id, int):
            return
        future = self._pending.get(req_id)
        if future is None or future.done():
            return
        error = message.get("error")
        if isinstance(error, dict):
            future.set_exception(RpcError(int(error.get("code", SHELL_ERROR)), str(error.get("message", "未知错误"))))
        else:
            future.set_result(message.get("result"))

    # ───────────────────────── 输出 ─────────────────────────

    def _write(self, payload: dict[str, Any]) -> None:
        # JSON 里不会有裸换行，所以 NDJSON 分帧是安全的
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        self._writer.write(line + "\n")
        self._writer.flush()

    def _write_error(self, req_id: int | None, code: int, message: str, data: Any | None = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        payload: dict[str, Any] = {"jsonrpc": "2.0", "error": error}
        if req_id is not None:
            payload["id"] = req_id
        self._write(payload)
