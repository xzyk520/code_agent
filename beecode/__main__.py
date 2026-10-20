"""内核入口：`python -m beecode`。

当前实现范围（M1）：
  - `initialize` / `shutdown` / `model.reload` / `proposal.read` / `proposal.decide`
  - **`chat.send`：单轮对话**（用户输入 → 调模型 → 流式吐字），见 `loop/agent.py`
  - `session.abort`：取消正在跑的那一轮

下一步（M2）才是工具循环；提示词、上下文、守卫都还是最小实现。

约定（与 TS 壳一致）：
  - 每行一个 JSON（NDJSON），stdin 读、stdout 写
  - **不要**往 stdout 打印任何调试信息！会破坏协议帧。调试用 stderr
  - `chat.send` 整轮结束才返回；进度用 `ui.delta` / `ui.tool` / `ui.usage` 通知
"""

from __future__ import annotations

import asyncio
import contextlib
import difflib
import sys
import uuid
from typing import Any

from . import __version__
from .ipc import (
    INVALID_PARAMS,
    PROTOCOL_VERSION,
    SHELL_ERROR,
    SIG_CONFLICT,
    SIG_NOT_FOUND,
    SIG_VERSION_MISMATCH,
    JsonRpcPeer,
    RequestContext,
    RpcError,
)
from .llm import ModelError
from .loop import AgentLoop, TurnConfig
from .session import Session
from .shell import ShellClient

#: 全局状态。真正复杂之后应该抽成 `Kernel` 类，现在够用。
_state: dict[str, Any] = {
    "initialized": False,
    "workspace_roots": [],
    "model_config": {},
    "api_key": None,
    "max_steps": 12,
    "tool_timeout_ms": 60_000,
    "subagent_config": {},
    "subagent_api_key": None,
}

#: 会话表：sessionId → Session（内存态，不持久化——历史由壳负责）
_sessions: dict[str, Session] = {}
#: 每个会话最多一个在跑的回合：sessionId → Task
_tasks: dict[str, asyncio.Task[None]] = {}
#: 提案："虚拟文件"内容只放在这里，壳按需通过 proposal.read 拉取
_PROPOSALS: dict[str, dict[str, Any]] = {}


def _peer() -> JsonRpcPeer:
    peer = _state.get("peer")
    if peer is None:
        raise RpcError(SHELL_ERROR, "内核尚未就绪")
    return peer


def _notify(method: str, params: dict[str, Any]) -> None:
    _peer().notify(method, params)


# ───────────────────────── 生命周期 ─────────────────────────


def _on_initialize(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    version = int(params.get("protocolVersion", 0))
    if version != PROTOCOL_VERSION:
        raise RpcError(SIG_VERSION_MISMATCH, f"协议版本不匹配：壳={version}，内核={PROTOCOL_VERSION}")

    _state["initialized"] = True
    _state["workspace_roots"] = list(params.get("workspaceRoots", []))
    _state["model_config"] = dict(params.get("modelConfig", {}))
    # 密钥只留在内存里，不落盘、不进日志
    _state["api_key"] = params.get("apiKey")
    _state["max_steps"] = int(params.get("maxSteps") or 12)
    _state["tool_timeout_ms"] = int(params.get("toolTimeoutMs") or 60_000)
    _state["subagent_config"] = dict(params.get("subagentConfig") or {})
    _state["subagent_api_key"] = params.get("subagentApiKey")

    _log(f"initialize: roots={len(_state['workspace_roots'])} model={_state['model_config'].get('model', '')}")
    return {"protocolVersion": PROTOCOL_VERSION, "coreVersion": __version__}


async def _on_shutdown(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    _log("shutdown：取消在飞回合")
    for sid, task in list(_tasks.items()):
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        _tasks.pop(sid, None)
    return {}


def _on_model_reload(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    _state["model_config"] = dict(params.get("modelConfig", {}))
    if params.get("apiKey"):
        _state["api_key"] = params.get("apiKey")
    if params.get("subagentConfig") is not None:
        _state["subagent_config"] = dict(params.get("subagentConfig") or {})
    if params.get("subagentApiKey"):
        _state["subagent_api_key"] = params.get("subagentApiKey")
    # 已存在的会话同步新配置（否则旧会话还在用旧 base_url）
    for session in _sessions.values():
        session.model_config = dict(_state["model_config"])
        session.api_key = _state["api_key"]
    _log("model.reload")
    return {}


# ───────────────────────── 一轮对话 ─────────────────────────


async def _on_chat_send(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    session_id = str(params.get("sessionId") or "")
    if not session_id:
        raise RpcError(INVALID_PARAMS, "缺少 sessionId")

    # 并发保护：同一会话同时只允许跑一轮（壳侧也有 busy 兜底，这里是纵深防御）
    running = _tasks.get(session_id)
    if running is not None and not running.done():
        raise RpcError(SIG_CONFLICT, "上一轮还没结束，请先停止或等待")

    mode = str(params.get("mode") or "chat")
    session = _sessions.get(session_id)
    if session is None:
        session = Session.create(session_id, mode, _state["model_config"], _state["api_key"])  # type: ignore[arg-type]
        _sessions[session_id] = session
    else:
        session.mode = mode  # type: ignore[assignment]
        session.model_config = dict(_state["model_config"])
        session.api_key = _state["api_key"]

    text = str(params.get("text") or "")
    attachments = list(params.get("attachments") or [])
    history = list(params.get("history") or [])
    summary = params.get("summary")

    loop = AgentLoop(
        _notify,
        _shell(),
        config=TurnConfig(
            max_steps=int(_state.get("max_steps") or 12),
            tool_timeout_s=max(5.0, float(_state.get("tool_timeout_ms") or 60_000) / 1000.0),
        ),
        propose=_propose,
        log=_log,
        spawn_enabled=bool(_state["subagent_config"].get("enabled", True)),
        spawn_config=dict(_state["subagent_config"]),
        spawn_api_key=_state["subagent_api_key"],
        spawn_max_steps=int(_state["subagent_config"].get("maxSteps") or 8),
    )
    task = asyncio.create_task(
        loop.run_turn(
            session,
            text=text,
            attachments=attachments,
            history=history,
            summary=summary if isinstance(summary, str) else None,
            focus=params.get("focus") if isinstance(params.get("focus"), dict) else None,
        )
    )
    _tasks[session_id] = task
    try:
        await task
    except asyncio.CancelledError:
        _log(f"chat.send 已取消：{session_id}")
        raise RpcError(SHELL_ERROR, "本轮已取消") from None
    except ModelError as exc:
        raise RpcError(SHELL_ERROR, str(exc)) from exc
    finally:
        _tasks.pop(session_id, None)
    return {}


async def _on_abort(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    session_id = str(params.get("sessionId") or "")
    task = _tasks.get(session_id)
    if task is None:
        _log(f"session.abort：{session_id} 没有在跑的回合")
        return {"aborted": False}
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task
    _log(f"session.abort：已取消 {session_id}")
    return {"aborted": True}


# ───────────────────────── 提案 ─────────────────────────


def _shell() -> ShellClient:
    shell = _state.get("shell")
    if shell is None:
        raise RpcError(SHELL_ERROR, "内核尚未就绪")
    return shell


async def _propose(path: str, content: str, summary: str) -> str:
    """把模型给出的完整文件内容登记为提案，并通知壳。

    - 先读一次当前文件拿 `version`：接受时作为 expectedVersion，防止覆盖用户新编辑
    - additions/deletions 用于卡片展示
    """
    proposal_id = f"p_{uuid.uuid4().hex[:10]}"
    base_text = ""
    base_version = None
    try:
        current = await _shell().read_file(path)
        base_text = current.text
        base_version = current.version
    except Exception as exc:  # noqa: BLE001 - 新文件或读取失败都不该阻断提案
        _log(f"proposal: 读取 {path} 失败（按新文件处理）：{exc}")

    additions, deletions = _count_changes(base_text, content)
    _PROPOSALS[proposal_id] = {
        "path": path,
        "text": content,
        "baseVersion": base_version,
        "summary": summary,
    }
    _notify(
        "proposal.changed",
        {
            "added": [
                {
                    "id": proposal_id,
                    "path": path,
                    "baseVersion": base_version,
                    "additions": additions,
                    "deletions": deletions,
                    "status": "pending",
                    "summary": summary or None,
                }
            ]
        },
    )
    _log(f"proposal {proposal_id}: {path} (+{additions}/-{deletions})")
    return proposal_id


def _count_changes(old: str, new: str) -> tuple[int, int]:
    additions = deletions = 0
    for line in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0):
        if line.startswith("+") and not line.startswith("+++"):
            additions += 1
        elif line.startswith("-") and not line.startswith("---"):
            deletions += 1
    return additions, deletions


def _on_proposal_read(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    """返回提案正文。用户点「查看」或「接受」时才会被调用。"""
    proposal_id = str(params.get("id", ""))
    proposal = _PROPOSALS.get(proposal_id)
    if proposal is None:
        raise RpcError(SIG_NOT_FOUND, f"提案不存在：{proposal_id}")
    return {"text": proposal["text"]}


def _on_proposal_decide(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    """壳已经落盘（accept）或已丢弃（reject）之后才调用。

    时序约定见 README §10：**壳先写、内核后知**，这里只做状态清理。
    """
    proposal_id = str(params.get("id", ""))
    decision = str(params.get("decision", ""))
    if decision not in ("accept", "reject"):
        raise RpcError(INVALID_PARAMS, f"未知的 decision：{decision}")
    existed = _PROPOSALS.pop(proposal_id, None) is not None
    _log(f"proposal.decide {proposal_id} → {decision}（{'存在' if existed else '已不存在'}）")
    if existed:
        _notify("proposal.changed", {"removed": [proposal_id]})
    return {"ok": existed}


# ───────────────────────── 入口 ─────────────────────────


def _log(message: str) -> None:
    # 只能写 stderr：stdout 是协议通道
    print(f"[beecode] {message}", file=sys.stderr, flush=True)


async def _serve() -> None:
    peer = JsonRpcPeer()
    _state["peer"] = peer
    _state["shell"] = ShellClient(peer)

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
