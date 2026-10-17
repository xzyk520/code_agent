"""内核入口：`python -m beecode`。

⚠️ 这个文件目前只是**协议骨架**：把 RPC 分发接好，业务留给实现者。
真正的 agent loop / 提示词 / 工具 / 补丁都在 `beecode/loop`、`prompts`、`tools`、`apply`
（见 README §15，尚未创建）。

约定（与 TS 壳一致）：
  - 每行一个 JSON（NDJSON），stdin 读、stdout 写
  - **不要**往 stdout 打印任何调试信息！会破坏协议帧。调试用 stderr。
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

from . import __version__
from .ipc import PROTOCOL_VERSION, JsonRpcPeer, RequestContext, SIG_VERSION_MISMATCH, RpcError
from .shell import ShellClient

# 会话状态：真正实现时应该放进 session.py，这里只留最小骨架
_state: dict[str, Any] = {
    "initialized": False,
    "workspace_roots": [],
    "model_config": {},
    "api_key": None,
}


def _on_initialize(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    version = int(params.get("protocolVersion", 0))
    if version != PROTOCOL_VERSION:
        raise RpcError(
            SIG_VERSION_MISMATCH,
            f"协议版本不匹配：壳={version}，内核={PROTOCOL_VERSION}",
        )

    _state["initialized"] = True
    _state["workspace_roots"] = list(params.get("workspaceRoots", []))
    _state["model_config"] = dict(params.get("modelConfig", {}))
    # 密钥只留在内存里，不落盘、不进日志
    _state["api_key"] = params.get("apiKey")

    _log(f"initialize: roots={len(_state['workspace_roots'])} model={_state['model_config'].get('model', '')}")
    return {"protocolVersion": PROTOCOL_VERSION, "coreVersion": __version__}


def _on_shutdown(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    _log("shutdown")
    return {}


def _on_model_reload(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    _state["model_config"] = dict(params.get("modelConfig", {}))
    if params.get("apiKey"):
        _state["api_key"] = params.get("apiKey")
    return {}


def _on_chat_send(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    """TODO(你来实现)：这是 agent loop 的入口。

    契约（README §4.5.2）：
      params = {sessionId, mode: "chat"|"builder"|"debugger", text, attachments[]}

    整轮结束才返回；过程中的流式输出用 peer.notify 推给壳：
      peer.notify("ui.delta", {"sessionId": sid, "text": chunk})
      peer.notify("ui.tool",  {"sessionId": sid, "name": "read_file", "status": "start"})
      peer.notify("pending.changed", {"added": [ ... PendingItem ... ]})
      peer.notify("ui.usage", {"sessionId": sid, "inputTokens": 0, "outputTokens": 0})

    要读写文件请用 ShellClient（见 shell.py），不要直接 open()。
    """
    raise RpcError(-32603, "chat.send 尚未实现（内核骨架）")


def _on_review(action: str):
    def handler(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        # TODO(你来实现)：Keep = 只改待审状态；Undo = 反向补丁后经 shell.apply_edit 落盘
        _log(f"review.{action}: {params}")
        return {}

    return handler


def _on_abort(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    # TODO(你来实现)：取消正在跑的 agent loop（asyncio.Task.cancel）
    _log(f"session.abort: {params.get('sessionId')}")
    return {}


def _log(message: str) -> None:
    # 只能写 stderr：stdout 是协议通道
    print(f"[beecode] {message}", file=sys.stderr, flush=True)


async def _serve() -> None:
    peer = JsonRpcPeer()
    shell = ShellClient(peer)
    _state["shell"] = shell

    peer.register("initialize", _on_initialize)
    peer.register("shutdown", _on_shutdown)
    peer.register("model.reload", _on_model_reload)
    peer.register("chat.send", _on_chat_send)
    peer.register("review.keep", _on_review("keep"))
    peer.register("review.undo", _on_review("undo"))
    peer.register("review.keepAll", _on_review("keepAll"))
    peer.register("review.undoAll", _on_review("undoAll"))
    peer.register("session.abort", _on_abort)

    _log(f"beecode {__version__} 已启动，等待壳的 initialize…")
    await peer.run()


def main() -> None:
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
