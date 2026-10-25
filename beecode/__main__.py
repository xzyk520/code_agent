"""Kernel entry point: `python -m beecode`.

Current scope (M1):
  - `initialize` / `shutdown` / `model.reload` / `proposal.read` / `proposal.decide`
  - **`chat.send`: single-turn conversation** (user input → model call → streamed tokens),
    see `loop/agent.py`
  - `session.abort`: cancel the turn that is currently running

The tool loop only arrives next (M2); prompts, context, and guards are still minimal.

Conventions (matching the TS shell):
  - One JSON per line (NDJSON): read from stdin, write to stdout
  - **Never** print any debug output to stdout! It corrupts protocol frames. Use stderr for debug
  - `chat.send` returns only when the whole turn is over; progress is reported via
    `ui.delta` / `ui.tool` / `ui.usage` notifications
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
from .llm import ModelError, OpenAIClient
from .loop import AgentLoop, TurnConfig
from .session import Session
from .shell import ShellClient
from .summarize import summarize_turns

#: Global state. Once this gets genuinely complex it should be extracted into a `Kernel` class; it is enough for now.
_state: dict[str, Any] = {
    "initialized": False,
    "workspace_roots": [],
    "model_config": {},
    "api_key": None,
    "max_steps": 12,
    "tool_timeout_ms": 60_000,
    "large_task_steps": 24,
    "max_turn_tokens": 200_000,
    "max_turn_seconds": 600.0,
    "large_task_seconds": 1_800.0,
    "subagent_config": {},
    "subagent_api_key": None,
    "summary_config": {},
    "summary_api_key": None,
}

#: Session table: sessionId → Session (in-memory, not persisted — history is the shell's job)
_sessions: dict[str, Session] = {}
#: At most one running turn per session: sessionId → Task
_tasks: dict[str, asyncio.Task[None]] = {}
#: Proposals: "virtual file" contents live only here; the shell pulls them on demand via proposal.read
_PROPOSALS: dict[str, dict[str, Any]] = {}


def _peer() -> JsonRpcPeer:
    peer = _state.get("peer")
    if peer is None:
        raise RpcError(SHELL_ERROR, "The kernel is not ready yet")
    return peer


def _notify(method: str, params: dict[str, Any]) -> None:
    _peer().notify(method, params)


# ───────────────────────── Lifecycle ─────────────────────────


def _on_initialize(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    version = int(params.get("protocolVersion", 0))
    if version != PROTOCOL_VERSION:
        raise RpcError(SIG_VERSION_MISMATCH, f"Protocol version mismatch: shell={version}, kernel={PROTOCOL_VERSION}")

    _state["initialized"] = True
    _state["workspace_roots"] = list(params.get("workspaceRoots", []))
    _state["model_config"] = dict(params.get("modelConfig", {}))
    # The key stays in memory only: never written to disk, never logged
    _state["api_key"] = params.get("apiKey")
    _state["max_steps"] = int(params.get("maxSteps") or 12)
    _state["tool_timeout_ms"] = int(params.get("toolTimeoutMs") or 60_000)
    _state["long_tool_timeout_ms"] = int(params.get("longToolTimeoutMs") or 600_000)
    _state["first_token_seconds"] = float(params.get("firstTokenSeconds") or 60)
    _state["idle_seconds"] = float(params.get("idleSeconds") or 45)
    _state["max_tool_calls_per_batch"] = int(params.get("maxToolCallsPerBatch") or 8)
    _state["large_task_steps"] = int(params.get("largeTaskSteps") or 24)
    _state["max_turn_tokens"] = int(params.get("maxTurnTokens") or 200_000)
    _state["max_turn_seconds"] = float(params.get("maxTurnSeconds") or 600)
    _state["large_task_seconds"] = float(params.get("largeTaskSeconds") or 1800)
    _state["subagent_config"] = dict(params.get("subagentConfig") or {})
    _state["subagent_api_key"] = params.get("subagentApiKey")
    _state["summary_config"] = dict(params.get("summaryConfig") or {})
    _state["summary_api_key"] = params.get("summaryApiKey")

    _log(f"initialize: roots={len(_state['workspace_roots'])} model={_state['model_config'].get('model', '')}")
    return {"protocolVersion": PROTOCOL_VERSION, "coreVersion": __version__}


async def _on_shutdown(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    _log("shutdown: cancelling in-flight turns")
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
    if params.get("summaryConfig") is not None:
        _state["summary_config"] = dict(params.get("summaryConfig") or {})
    if params.get("summaryApiKey"):
        _state["summary_api_key"] = params.get("summaryApiKey")
    # Sync the new config into existing sessions (otherwise old sessions keep using the old base_url)
    for session in _sessions.values():
        session.model_config = dict(_state["model_config"])
        session.api_key = _state["api_key"]
    _log("model.reload")
    return {}


# ───────────────────────── One conversation turn ─────────────────────────


async def _on_chat_send(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    session_id = str(params.get("sessionId") or "")
    if not session_id:
        raise RpcError(INVALID_PARAMS, "Missing sessionId")

    # Concurrency guard: only one turn may run per session at a time (the shell also has a busy
    # fallback; this is defense in depth)
    running = _tasks.get(session_id)
    if running is not None and not running.done():
        raise RpcError(SIG_CONFLICT, "The previous turn has not finished; stop it or wait before starting another")

    mode = str(params.get("mode") or "chat")
    session = _sessions.get(session_id)
    raw_last_intent = params.get("lastIntent")
    if isinstance(raw_last_intent, dict):
        session.last_intent = {
            "mode": str(raw_last_intent.get("mode") or "chat"),
            "scale": str(raw_last_intent.get("scale") or "small"),
            "needs_proposal": bool(raw_last_intent.get("needsProposal")),
            "intent": str(raw_last_intent.get("intent") or ""),
            "reason": str(raw_last_intent.get("reason") or ""),
        }
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
            long_tool_timeout_s=max(5.0, float(_state.get("long_tool_timeout_ms") or 600_000) / 1000.0),
            context_window_tokens=int((_state.get("model_config") or {}).get("contextWindow") or 32_768),
            large_task_steps=int(_state.get("large_task_steps") or 24),
            max_turn_tokens=int(_state.get("max_turn_tokens") or 200_000),
            max_turn_seconds=float(_state.get("max_turn_seconds") or 600),
            large_task_seconds=float(_state.get("large_task_seconds") or 1800),
            first_token_seconds=float(_state.get("first_token_seconds") or 60),
            idle_seconds=float(_state.get("idle_seconds") or 45),
            max_tool_calls_per_batch=int(_state.get("max_tool_calls_per_batch") or 8),
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
            plan=params.get("plan") if isinstance(params.get("plan"), list) else None,
        )
    )
    _tasks[session_id] = task
    try:
        await task
    except asyncio.CancelledError:
        _log(f"chat.send cancelled: {session_id}")
        raise RpcError(SHELL_ERROR, "This turn was cancelled") from None
    except ModelError as exc:
        raise RpcError(SHELL_ERROR, str(exc)) from exc
    finally:
        _tasks.pop(session_id, None)
    return {}


async def _on_abort(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    session_id = str(params.get("sessionId") or "")
    task = _tasks.get(session_id)
    if task is None:
        _log(f"session.abort: {session_id} has no running turn")
        return {"aborted": False}
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task
    _log(f"session.abort: cancelled {session_id}")
    return {"aborted": True}


async def _on_context_summarize(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    """Produce a model summary per turn (called by the shell while compressing context)."""
    turns = list(params.get("turns") or [])
    config = _state.get("model_config") or {}
    summary = _state.get("summary_config") or {}
    summary_model = str(summary.get("model") or "").strip()
    if summary_model:
        summary_base = str(summary.get("baseUrl") or config.get("baseUrl") or "")
        client = OpenAIClient(
            base_url=summary_base,
            model=summary_model,
            api_key=_state.get("summary_api_key") or _state.get("api_key"),
        )
        _log(f"context.summarize: using summary model {summary_model}")
    else:
        client = OpenAIClient(
            base_url=str(config.get("baseUrl") or ""),
            model=str(config.get("model") or ""),
            api_key=_state.get("api_key"),
        )
    try:
        result = await summarize_turns(client, turns, log=_log)
    except ModelError as exc:
        if not summary_model:
            raise
        _log(f"summary model failed, falling back to the main model: {exc}")
        fallback = OpenAIClient(
            base_url=str(config.get("baseUrl") or ""),
            model=str(config.get("model") or ""),
            api_key=_state.get("api_key"),
        )
        result = await summarize_turns(fallback, turns, log=_log)
    _log(f"context.summarize: {len(turns)} turns → {len(result.get('pairs') or [])} pairs")
    return result


# ───────────────────────── Proposals ─────────────────────────


def _shell() -> ShellClient:
    shell = _state.get("shell")
    if shell is None:
        raise RpcError(SHELL_ERROR, "The kernel is not ready yet")
    return shell


async def _propose(path: str, content: str, summary: str, *, expected_version: int | None = None) -> str:
    """Register the full file content given by the model as a proposal, and notify the shell.

    - Read the current file once to obtain its `version`: used as expectedVersion on accept,
      so a fresh user edit is never overwritten
    - additions/deletions are used for card display
    """
    proposal_id = f"p_{uuid.uuid4().hex[:10]}"
    base_text = ""
    base_version = None
    try:
        current = await _shell().read_file(path)
        base_text = current.text
        base_version = current.version
        if expected_version is not None and current.version != expected_version:
            raise ValueError(f"{path} has been modified (version {current.version} != {expected_version}); read it again before editing")
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001 - a new file or a failed read must not block the proposal
        if expected_version is not None:
            raise ValueError(f"{path} was deleted or could not be read before the edit; read it again before editing") from exc
        _log(f"proposal: failed to read {path} (treating it as a new file): {exc}")

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
    """Return the proposal body. Only called when the user clicks "view" or "accept"."""
    proposal_id = str(params.get("id", ""))
    proposal = _PROPOSALS.get(proposal_id)
    if proposal is None:
        raise RpcError(SIG_NOT_FOUND, f"Proposal not found: {proposal_id}")
    return {"text": proposal["text"]}


def _on_proposal_decide(params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
    """Only called after the shell has written (accept) or discarded (reject) the proposal.

    See README §10 for the ordering contract: **the shell writes first, the kernel learns
    afterwards**; this handler only cleans up state.
    """
    proposal_id = str(params.get("id", ""))
    decision = str(params.get("decision", ""))
    if decision not in ("accept", "reject"):
        raise RpcError(INVALID_PARAMS, f"Unknown decision: {decision}")
    existed = _PROPOSALS.pop(proposal_id, None) is not None
    _log(f"proposal.decide {proposal_id} → {decision} ({'present' if existed else 'already gone'})")
    if existed:
        _notify("proposal.changed", {"removed": [proposal_id]})
    return {"ok": existed}


# ───────────────────────── Entry point ─────────────────────────


def _log(message: str) -> None:
    # stderr only: stdout is the protocol channel
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
    peer.register("context.summarize", _on_context_summarize)

    _log(f"beecode {__version__} started, waiting for the shell's initialize…")
    await peer.run()


def main() -> None:
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
