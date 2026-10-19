"""内置工具实现：薄封装 ShellClient，只做"参数整形 + 结果压缩"。

原则：
  - 返回的 dict 必须**紧凑**（会被塞回模型上下文）
  - 出错直接抛异常，由 loop 转成 tool 消息（模型看得见、能改策略）
  - 不做权限判断（壳侧统一判定）
"""

from __future__ import annotations

import json
from typing import Any

from . import ToolContext

#: 单个工具结果最多这么多字符（约 4k token），超出截断并标记
MAX_RESULT_CHARS = 16_000


def _clip(value: Any) -> dict[str, Any]:
    text = json.dumps(value, ensure_ascii=False)
    if len(text) <= MAX_RESULT_CHARS:
        return dict(value) if isinstance(value, dict) else {"result": value}
    return {
        "truncated": True,
        "preview": text[:MAX_RESULT_CHARS],
        "note": f"结果过长（{len(text)} 字符），已截断；请缩小范围（行范围/glob/max_results）",
    }


async def read_file(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.read_file(
        str(params["path"]),
        start_line=_int_or_none(params.get("start_line")),
        end_line=_int_or_none(params.get("end_line")),
    )
    return _clip(
        {
            "path": params["path"],
            "text": result.text,
            "startLine": result.start_line,
            "endLine": result.end_line,
            "totalLines": result.total_lines,
            "truncated": result.truncated,
        }
    )


async def list_files(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.list_files_result(
        glob=str(params.get("glob") or "**/*"),
        max_results=int(params.get("max_results") or 500),
    )
    return _clip({"files": result.get("paths", []), "truncated": result.get("truncated", False)})


async def search_code(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    query = str(params["query"])
    if params.get("files_only"):
        result = await ctx.shell.grep_files(
            query,
            regex=bool(params.get("regex")),
            glob=_str_or_none(params.get("glob")),
            max_results=int(params.get("max_results") or 100),
        )
        return _clip({"files": result.get("files", []), "truncated": result.get("truncated", False)})

    hits = await ctx.shell.grep(
        query,
        regex=bool(params.get("regex")),
        glob=_str_or_none(params.get("glob")),
        context_lines=0,
        max_results=int(params.get("max_results") or 50),
    )
    return _clip(
        {
            "hits": [
                {"path": h.path, "line": h.line, "col": h.col, "text": h.text, "count": h.count}
                for h in hits
            ]
        }
    )


async def file_outline(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    symbols = await ctx.shell.outline(str(params["path"]))
    return _clip(
        {
            "symbols": [
                {"name": s.name, "kind": s.kind, "startLine": s.start_line, "endLine": s.end_line, "container": s.container}
                for s in symbols
            ]
        }
    )


async def find_symbol(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.symbols_search(
        str(params["query"]), max_results=int(params.get("max_results") or 30)
    )
    return _clip({"symbols": result.get("symbols", []), "source": result.get("source"), "truncated": result.get("truncated")})


async def find_references(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.references_of_symbol(str(params["path"]), str(params["symbol"]))
    return _clip({"locations": result.get("locations", []), "truncated": result.get("truncated", False)})


async def get_diagnostics(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.diagnostics_result(
        _str_or_none(params.get("path")), min_severity="warning", max_items=100
    )
    items = [
        {
            "path": d.get("path"),
            "severity": d.get("severity"),
            "code": d.get("code"),
            "message": str(d.get("message") or "")[:300],
            "line": (d.get("range") or {}).get("startLine"),
        }
        for d in result.get("items", [])
    ]
    return _clip({"diagnostics": items, "total": result.get("total"), "truncated": result.get("truncated")})


async def propose_edit(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    path = str(params["path"])
    content = str(params["content"])
    summary = str(params.get("summary") or "")
    if not content.strip():
        raise ValueError("content 为空：请提供修改后的完整文件内容")
    proposal_id = await ctx.propose(path, content, summary)
    return {"ok": True, "proposalId": proposal_id, "path": path, "summary": summary}


async def run_command(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.run(
        str(params["command"]),
        cwd=_str_or_none(params.get("cwd")),
        timeout_ms=_int_or_none(params.get("timeout_ms")),
    )
    return _clip(
        {
            "exitCode": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "truncated": result.truncated,
            "killed": result.killed,
            "sandbox": result.sandbox,
            "durationMs": result.duration_ms,
            "ok": result.ok,
        },
    )


async def update_plan(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """把计划推给面板（模型每次传全量步骤，覆盖上一次的状态）。"""
    if ctx.plan is None:
        raise RuntimeError("当前 agent 不支持计划")
    raw = params.get("steps")
    if not isinstance(raw, list) or not raw:
        raise ValueError("steps 不能为空：请传 3-6 个具体步骤")
    steps: list[dict[str, str]] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            steps.append({"text": item.strip(), "status": "pending"})
        elif isinstance(item, dict) and str(item.get("text") or "").strip():
            status = item.get("status") if item.get("status") in ("pending", "doing", "done") else "pending"
            steps.append({"text": str(item["text"]).strip(), "status": str(status)})
    if not steps:
        raise ValueError("steps 里没有有效步骤")
    ctx.plan(steps)
    return {"ok": True, "steps": len(steps)}


async def spawn_subagent(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """派一个只读子代理。结果只回传结论，不回传它的上下文。"""
    if ctx.spawn is None:
        raise RuntimeError("当前 agent 不允许派生子代理")
    task = str(params.get("task") or "").strip()
    if not task:
        raise ValueError("task 不能为空：请写清楚要让子代理查什么")
    max_steps = int(params.get("max_steps") or 8)
    return await ctx.spawn(task, max_steps)


def _int_or_none(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None
