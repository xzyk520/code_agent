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
      peer.notify("proposal.changed", {"added": [ ... ProposalDto ... ]})
      peer.notify("ui.usage", {"sessionId": sid, "inputTokens": 0, "outputTokens": 0})

    要读写文件请用 ShellClient（见 shell.py），不要直接 open()。
    """
    raise RpcError(-32603, "chat.send 尚未实现（内核骨架）")


#: 提案："虚拟文件"内容只放在这里，壳按需通过 proposal.read 拉取
_PROPOSALS: dict[str, dict[str, Any]] = {}


def _on_proposal_read(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    """返回提案正文。用户点「查看」或「接受」时才会被调用。"""
    proposal_id = str(params.get("id", ""))
    proposal = _PROPOSALS.get(proposal_id)
    if proposal is None:
        raise RpcError(-32012, f"提案不存在：{proposal_id}")
    return {"text": proposal["text"]}


def _on_proposal_decide(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    """壳已经落盘（accept）或已丢弃（reject）之后才调用。

    时序约定见 README §10：**壳先写、内核后知**，这里只做状态清理。
    """
    proposal_id = str(params.get("id", ""))
    decision = str(params.get("decision", ""))
    if decision not in ("accept", "reject"):
        raise RpcError(-32602, f"未知的 decision：{decision}")
    existed = _PROPOSALS.pop(proposal_id, None) is not None
    _log(f"proposal.decide {proposal_id} → {decision}（{'存在' if existed else '已不存在'}）")
    if existed:
        peer_ref = _state.get("peer")
        if peer_ref is not None:
            peer_ref.notify("proposal.changed", {"removed": [proposal_id]})
    return {"ok": existed}


def _on_abort(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    # TODO(你来实现)：取消正在跑的 agent loop（asyncio.Task.cancel）
    _log(f"session.abort: {params.get('sessionId')}")
    return {}


def _log(message: str) -> None:
    # 只能写 stderr：stdout 是协议通道
    print(f"[beecode] {message}", file=sys.stderr, flush=True)


async def _serve() -> None:
    peer = JsonRpcPeer()
    _state["peer"] = peer
    shell = ShellClient(peer)
    _state["shell"] = shell

    peer.register("initialize", _on_initialize)
    peer.register("shutdown", _on_shutdown)
    peer.register("model.reload", _on_model_reload)
    peer.register("chat.send", _on_chat_send)
    peer.register("proposal.read", _on_proposal_read)
    peer.register("proposal.decide", _on_proposal_decide)
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
