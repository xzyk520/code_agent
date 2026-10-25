"""Built-in tool implementations: thin wrappers over ShellClient that only "shape parameters + compress results".

Principles:
  - Returned dicts must be **compact** (they are fed back into the model context)
  - Raise errors directly and let the loop turn them into tool messages (the model sees them and can adjust strategy)
  - Do not make permission decisions (the shell decides uniformly)
"""

from __future__ import annotations

import json
import posixpath
import re
import uuid
from typing import Any

from . import ToolContext

#: Maximum characters in a single tool result (about 4k tokens); longer results are truncated and marked
MAX_RESULT_CHARS = 16_000


def _clip(value: Any) -> dict[str, Any]:
    text = json.dumps(value, ensure_ascii=False)
    if len(text) <= MAX_RESULT_CHARS:
        return dict(value) if isinstance(value, dict) else {"result": value}
    return {
        "truncated": True,
        "preview": text[:MAX_RESULT_CHARS],
        "note": f"Result too long ({len(text)} chars); truncated. Narrow the range (line range/glob/max_results).",
    }


#: "Head + tail" strategy for reading long text (the model needs a location, not the full text)
HEAD_LINES = 120
TAIL_LINES = 30
MAX_LINES = HEAD_LINES + TAIL_LINES + 20


def _shape_text(text: str, *, head: int = HEAD_LINES, tail: int = TAIL_LINES) -> tuple[str, int]:
    """Compress long text into "head + omission notice + tail"; returns (text, omitted line count)."""
    lines = text.splitlines()
    if len(lines) <= head + tail + 10:
        return text, 0
    omitted = len(lines) - head - tail
    shaped = "\n".join(
        [*lines[:head], f"… ({omitted} lines omitted; use start_line/end_line to read a smaller range) …", *lines[-tail:]]
    )
    return shaped, omitted


def _path_key(path: str) -> str:
    return posixpath.normpath(path.replace("\\", "/"))


def _line_count(text: str) -> int:
    return text.count("\n") + 1 if text else 0


async def read_skill(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """Read one installed skill's full SKILL.md body."""
    from ..skills import read_skill as load_one
    name = str(params.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")
    skill = load_one(name)
    if skill is None:
        raise ValueError(f"Skill not found: {name}")
    return {"name": skill.name, "description": skill.description, "path": skill.path, "body": skill.body[:20000]}


async def read_file(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.read_file(
        str(params["path"]),
        start_line=_int_or_none(params.get("start_line")),
        end_line=_int_or_none(params.get("end_line")),
    )
    ctx.observed[_path_key(str(params["path"]))] = result.version
    shaped, omitted = _shape_text(result.text)
    payload: dict[str, Any] = {
        "path": params["path"],
        "text": shaped,
        "startLine": result.start_line,
        "endLine": result.end_line,
        "totalLines": result.total_lines,
        "truncated": result.truncated or omitted > 0,
    }
    if omitted > 0:
        payload["omittedLines"] = omitted
        payload["note"] = f"{omitted} lines omitted in the middle; use a smaller line range for details"
    return _clip(payload)


async def list_files(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.list_files_result(
        glob=str(params.get("glob") or "**/*"),
        max_results=int(params.get("max_results") or 200),
    )
    paths = list(result.get("paths", []))[:200]
    return _clip(
        {
            "files": paths,
            "truncated": bool(result.get("truncated")) or len(result.get("paths", [])) > len(paths),
        }
    )


async def search_code(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    query = str(params["query"])
    if params.get("files_only"):
        result = await ctx.shell.grep_files(
            query,
            regex=bool(params.get("regex")),
            glob=_str_or_none(params.get("glob")),
            max_results=int(params.get("max_results") or 100),
        )
        files = list(result.get("files", []))[:100]
        return _clip({"files": files, "truncated": bool(result.get("truncated")) or len(result.get("files", [])) > len(files)})

    hits = await ctx.shell.grep(
        query,
        regex=bool(params.get("regex")),
        glob=_str_or_none(params.get("glob")),
        context_lines=0,
        max_results=int(params.get("max_results") or 50),
    )
    rows = []
    for hit in hits[:50]:
        text = hit.text if len(hit.text) <= 160 else f"{hit.text[:157]}…"
        rows.append({"path": hit.path, "line": hit.line, "col": hit.col, "text": text, "count": hit.count})
    return _clip({"hits": rows, "total": len(hits), "truncated": len(hits) > len(rows)})

async def file_outline(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    symbols = await ctx.shell.outline(str(params["path"]))
    rows = [
        {"name": s.name, "kind": s.kind, "startLine": s.start_line, "endLine": s.end_line, "container": s.container}
        for s in symbols
    ][:200]
    return _clip({"path": params["path"], "symbols": rows, "truncated": len(symbols) > len(rows)})


async def find_symbol(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.symbols_search(
        str(params["query"]), max_results=int(params.get("max_results") or 30)
    )
    symbols = list(result.get("symbols", []))[:30]
    return _clip({"symbols": symbols, "source": result.get("source"), "truncated": bool(result.get("truncated")) or len(result.get("symbols", [])) > len(symbols)})


async def find_references(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.references_of_symbol(str(params["path"]), str(params["symbol"]))
    locations = list(result.get("locations", []))[:30]
    return _clip({"locations": locations, "truncated": bool(result.get("truncated")) or len(result.get("locations", [])) > len(locations)})


async def get_diagnostics(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.diagnostics_result(
        _str_or_none(params.get("path")), min_severity="warning", max_items=100
    )
    raw_items = result.get("items", [])
    counts: dict[str, int] = {}
    for item in raw_items:
        key = str(item.get("severity") or "unknown")
        counts[key] = counts.get(key, 0) + 1
    items = [
        {
            "path": d.get("path"),
            "severity": d.get("severity"),
            "code": d.get("code"),
            "message": str(d.get("message") or "")[:200],
            "line": (d.get("range") or {}).get("startLine"),
        }
        for d in raw_items[:20]
    ]
    return _clip(
        {
            "counts": counts,
            "diagnostics": items,
            "total": result.get("total"),
            "truncated": bool(result.get("truncated")) or len(raw_items) > len(items),
        }
    )


async def propose_edit(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    path = str(params["path"])
    content = str(params["content"])
    summary = str(params.get("summary") or "")
    if not content.strip():
        raise ValueError("content is empty: provide the complete new file content")
    proposal_id = await ctx.propose(path, content, summary)
    return {"ok": True, "proposalId": proposal_id, "path": path, "summary": summary}


async def edit_file(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """Targeted replacement: give the model only old_string/new_string; the kernel reads the file and creates the proposal."""
    path = str(params["path"])
    old_string = str(params.get("old_string") or "")
    new_string = str(params.get("new_string") or "")
    replace_all = bool(params.get("replace_all", False))
    summary = str(params.get("summary") or "").strip()
    if not old_string:
        raise ValueError("old_string must not be empty")
    if old_string == new_string:
        raise ValueError("old_string and new_string are identical; nothing to change")
    path_key = _path_key(path)
    if path_key not in ctx.observed:
        raise ValueError(f"Cannot modify {path}: the file has not been read; call read_file first and retry")
    current = await ctx.shell.read_file(path)
    if ctx.observed.get(path_key) != current.version:
        raise ValueError(f"Cannot modify {path}: the file changed; call read_file again and retry")
    count = current.text.count(old_string)
    if count == 0:
        raise ValueError(f"Cannot modify {path}: old_string was not found")
    if count > 1 and not replace_all:
        raise ValueError(f"Cannot modify {path}: old_string matches {count} places; provide more context or set replace_all=true")
    updated = current.text.replace(old_string, new_string) if replace_all else current.text.replace(old_string, new_string, 1)
    if updated == current.text:
        raise ValueError("The edit produced no change")
    if not summary:
        summary = f"edit_file: {path} ({count if replace_all else 1} replacement(s))"
    proposal_id = await ctx.propose(path, updated, summary, expected_version=current.version)
    return {
        "ok": True,
        "proposalId": proposal_id,
        "path": path,
        "replacements": count if replace_all else 1,
        "mode": "replace_all" if replace_all else "single",
    }


async def run_command(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    sandbox = str(params.get("sandbox") or "sandbox-readonly")
    if sandbox not in ("sandbox-readonly", "sandbox", "sandbox-network", "host"):
        raise ValueError("sandbox must be sandbox-readonly, sandbox, sandbox-network, or host")
    justification = str(params.get("justification") or "").strip()
    if sandbox != "sandbox-readonly" and not justification:
        raise ValueError(f"sandbox={sandbox} requires justification explaining why the extra permission is needed")
    yield_ms = _int_or_none(params.get("yield_ms"))
    if yield_ms is None:
        # Accept the legacy parameter name; it is not a process-killing timeout, just how long this call waits before returning "running"
        yield_ms = _int_or_none(params.get("timeout_ms"))
    if yield_ms is None:
        yield_ms = 120_000
    yield_ms = max(1_000, min(int(yield_ms), 300_000))
    result = await ctx.shell.run(
        str(params["command"]),
        cwd=_str_or_none(params.get("cwd")),
        yield_ms=yield_ms,
        sandbox=sandbox,
        justification=justification,
    )
    return _run_payload(result)


async def command_wait(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """Keep waiting on a long command; returns new output, elapsed time, and next-step suggestions."""
    job_id = str(params.get("job_id") or "").strip()
    if not job_id:
        raise ValueError("job_id must not be empty")
    yield_ms = _int_or_none(params.get("yield_ms"))
    result = await ctx.shell.wait(job_id, yield_ms=yield_ms)
    return _run_payload(result)


async def command_list(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """List background jobs still managed by the current session."""
    jobs = await ctx.shell.list_jobs()
    return {"jobs": jobs, "count": len(jobs)}


async def command_terminate(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """Terminate a long command and return the output collected so far."""
    job_id = str(params.get("job_id") or "").strip()
    if not job_id:
        raise ValueError("job_id must not be empty")
    result = await ctx.shell.terminate(job_id)
    return _run_payload(result)


def _run_payload(result: Any) -> dict[str, Any]:
    stdout, out_omitted = _shape_text(result.stdout, head=100, tail=40)
    stderr, err_omitted = _shape_text(result.stderr, head=40, tail=10)
    payload: dict[str, Any] = {
        "exitCode": result.exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "truncated": result.truncated or out_omitted > 0 or err_omitted > 0,
        "killed": result.killed,
        "sandbox": result.sandbox,
        "durationMs": result.duration_ms,
        "status": result.status,
        "ok": result.ok,
    }
    if result.backgrounded:
        payload["backgrounded"] = True
    if result.has_new_output:
        payload["hasNewOutput"] = True
    if result.no_new_output:
        payload["noNewOutput"] = True
    if result.notice:
        payload["notice"] = result.notice
    if result.job_id:
        payload["jobId"] = result.job_id
    if result.status == "running":
        payload["elapsedMs"] = result.elapsed_ms
        payload["progress"] = result.progress or ("No new output" if result.no_new_output else "Still running")
        payload["hint"] = (
            "The command is running in the background. Choose the interval for command_wait(job_id, yield_ms); "
            "if progress stalls or the approach is wrong, stop it with command_terminate(job_id). Do not re-run the same command."
        )
    elif result.elapsed_ms:
        payload["elapsedMs"] = result.elapsed_ms
    if result.output_age_ms is not None:
        payload["outputAgeMs"] = result.output_age_ms
    if out_omitted:
        payload["stdoutOmittedLines"] = out_omitted
    if err_omitted:
        payload["stderrOmittedLines"] = err_omitted
    return _clip(payload)


async def diagram(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """Hand Mermaid source to the shell for rendering and attach it to this turn's assistant message."""
    if ctx.diagram is None:
        raise RuntimeError("This agent does not support diagrams")
    kind = str(params.get("kind") or "").strip().lower()
    if kind not in {"flowchart", "sequence", "class", "state", "er"}:
        raise ValueError("kind must be flowchart / sequence / class / state / er")
    source = str(params.get("source") or "").strip()
    # Tolerate the model including the fence as well
    source = re.sub(r"^```[a-zA-Z]*\s*\n?", "", source)
    source = re.sub(r"\n?```\s*$", "", source).strip()
    if not source:
        raise ValueError("source must not be empty")
    if len(source) > 8_000:
        raise ValueError(f"Diagram too large ({len(source)} chars); keep it under 8000 chars and at most 20 nodes")
    lowered = source.lower()
    if "<script" in lowered or "javascript:" in lowered:
        raise ValueError("Diagrams must not contain scripts or javascript: links")
    if "%%{" in source:
        raise ValueError("Do not use Mermaid init directives (they override safety/theme settings)")
    title = str(params.get("title") or "").strip()[:80]
    payload = {
        "id": f"d_{uuid.uuid4().hex[:8]}",
        "kind": kind,
        "title": title,
        "source": source,
    }
    ctx.diagram(payload)
    return {
        "tool": "diagram",
        "ok": True,
        "id": payload["id"],
        "kind": kind,
        "title": title,
        "note": "Rendered. Add 3-5 lines of conclusions after the diagram; do not send only the diagram.",
    }


async def update_plan(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """Push the plan to the panel (the model sends the full step list each time, replacing the previous state)."""
    if ctx.plan is None:
        raise RuntimeError("This agent does not support plans")
    raw = params.get("steps")
    if not isinstance(raw, list) or not raw:
        raise ValueError("steps must not be empty: provide 3-6 concrete steps")
    steps: list[dict[str, str]] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            steps.append({"text": item.strip(), "status": "pending"})
        elif isinstance(item, dict) and str(item.get("text") or "").strip():
            status = item.get("status") if item.get("status") in ("pending", "doing", "done") else "pending"
            steps.append({"text": str(item["text"]).strip(), "status": str(status)})
    if not steps:
        raise ValueError("steps contains no valid steps")
    ctx.plan(steps)
    return {"ok": True, "steps": len(steps)}


async def spawn_subagent(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """Spawn a read-only subagent. Only its conclusion is returned, not its context."""
    if ctx.spawn is None:
        raise RuntimeError("This agent cannot spawn subagents")
    task = str(params.get("task") or "").strip()
    if not task:
        raise ValueError("task must not be empty: state exactly what the subagent should investigate")
    max_steps = int(params.get("max_steps") or 8)
    return await ctx.spawn(task, max_steps)


def _int_or_none(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None
