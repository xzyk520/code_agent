"""Shell ↔ kernel transport layer (JSON-RPC 2.0 over stdio / NDJSON).

This layer is the **protocol skeleton** and has nothing to do with agent logic: the loop,
dispatch, cancellation, and request timeouts. Business handlers are registered by
`__main__.py`.

TS counterpart: `src/rpc/client.ts` (the shell acts as server) and `src/protocol.ts` (types).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import sys
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

PROTOCOL_VERSION = 39

# ---------------------------------------------------------------------------
# Error codes (kept in sync with RpcError in src/protocol.ts)
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
    """Context of a single shell → kernel request."""

    #: JSON-RPC allows number or string
    id: int | str
    method: str
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)

    def throw_if_cancelled(self) -> None:
        if self.cancelled.is_set():
            raise asyncio.CancelledError("request cancelled")


Handler = Callable[[dict[str, Any], RequestContext], Any | Awaitable[Any]]


class JsonRpcPeer:
    """NDJSON peer on stdin/stdout.

    Both directions must be supported:
      - shell → kernel: this class **dispatches** to the registered handler
      - kernel → shell: this class **sends requests** and awaits responses (`request()`),
        matching `shell.py`
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
        self._tasks: dict[str, asyncio.Task[None]] = {}
        #: Request contexts: on cancellation we must set their cancelled event (so synchronous code can observe cancellation too)
        self._contexts: dict[str, RequestContext] = {}
        self._write_lock = asyncio.Lock()
        self._closed = False

    # ───────────────────────── Registration and sending ─────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def notify(self, method: str, params: Any | None = None) -> None:
        """One-way notification (no id, no reply expected)."""
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    async def request(self, method: str, params: Any | None = None, timeout: float = 30.0) -> Any:
        """Kernel → shell request that waits for the response. Raises RpcError on timeout."""
        req_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future
        self._write({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}})
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            self._cancel_outbound(req_id)
            raise RpcError(SHELL_ERROR, f"RPC 超时：{method}（{timeout}s）") from exc
        except asyncio.CancelledError:
            # When the parent task is cancelled we must tell the shell to abort the matching
            # inbound request, otherwise the run_command process/container keeps running
            # (see abort handling in runAdapter).
            self._cancel_outbound(req_id)
            raise
        finally:
            self._pending.pop(req_id, None)

    def _cancel_outbound(self, req_id: int) -> None:
        try:
            self._write({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": req_id}})
        except Exception:  # noqa: BLE001 - the peer may already be closed
            pass

    # ───────────────────────── Main loop ─────────────────────────

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

        # stdin closed: cancel all in-flight tasks, then exit
        for task in list(self._tasks.values()):
            task.cancel()
        self._closed = True

    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        raw_id = message.get("id")
        # JSON-RPC allows number or string; bool is a subclass of int, so exclude it
        has_id = isinstance(raw_id, (int, str)) and not isinstance(raw_id, bool)

        if "method" not in message:
            # This is a response from the peer (the shell) to us
            self._settle(message)
            return

        if method == "$/cancelRequest":
            params = message.get("params") or {}
            target = params.get("id")
            if isinstance(target, (int, str)) and not isinstance(target, bool):
                key = str(target)
                context = self._contexts.get(key)
                if context is not None:
                    context.cancelled.set()
                task = self._tasks.get(key)
                if task is not None:
                    task.cancel()
            return

        if not has_id:
            self._dispatch_notification(method, message.get("params") or {})
            return

        req_id = message["id"]
        key = str(req_id)
        task = asyncio.create_task(self._run_handler(req_id, method, message.get("params") or {}))
        self._tasks[key] = task
        task.add_done_callback(lambda _t, k=key: self._tasks.pop(k, None))

    def _dispatch_notification(self, method: str, params: dict[str, Any]) -> None:
        handler = self._handlers.get(method)
        if handler is None:
            return
        try:
            result = handler(params, RequestContext(id=0, method=method))
            if inspect.isawaitable(result):
                asyncio.create_task(result)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001 - a failed notification must not take down the main loop
            pass

    async def _run_handler(self, req_id: int | str, method: str, params: dict[str, Any]) -> None:
        handler = self._handlers.get(method)
        if handler is None:
            self._write_error(req_id, METHOD_NOT_FOUND, f"未知方法：{method}")
            return

        ctx = RequestContext(id=req_id, method=method)
        key = str(req_id)
        self._contexts[key] = ctx
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
        finally:
            self._contexts.pop(key, None)

    def _settle(self, message: dict[str, Any]) -> None:
        req_id = message.get("id")
        # Every request id we send out is an int; a string id is a peer bug
        if not isinstance(req_id, int) or isinstance(req_id, bool):
            return
        future = self._pending.get(req_id)
        if future is None or future.done():
            return
        error = message.get("error")
        if isinstance(error, dict):
            future.set_exception(RpcError(int(error.get("code", SHELL_ERROR)), str(error.get("message", "未知错误"))))
        else:
            future.set_result(message.get("result"))

    # ───────────────────────── Output ─────────────────────────

    def _write(self, payload: dict[str, Any]) -> None:
        # JSON never contains raw newlines, so NDJSON framing is safe
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
