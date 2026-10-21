"""内置工具实现：薄封装 ShellClient，只做"参数整形 + 结果压缩"。

原则：
  - 返回的 dict 必须**紧凑**（会被塞回模型上下文）
  - 出错直接抛异常，由 loop 转成 tool 消息（模型看得见、能改策略）
  - 不做权限判断（壳侧统一判定）
"""

from __future__ import annotations

import json
import re
import uuid
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


#: 读取大段文本时的"头 + 尾"策略（模型需要的是定位，不是全文）
HEAD_LINES = 120
TAIL_LINES = 30
MAX_LINES = HEAD_LINES + TAIL_LINES + 20


def _shape_text(text: str, *, head: int = HEAD_LINES, tail: int = TAIL_LINES) -> tuple[str, int]:
    """把长文本压成"头 + 省略提示 + 尾"，返回 (文本, 省略行数)。"""
    lines = text.splitlines()
    if len(lines) <= head + tail + 10:
        return text, 0
    omitted = len(lines) - head - tail
    shaped = "\n".join(
        [*lines[:head], f"…（省略 {omitted} 行；需要时用 start_line/end_line 精确读取）…", *lines[-tail:]]
    )
    return shaped, omitted


def _line_count(text: str) -> int:
    return text.count("\n") + 1 if text else 0


async def read_file(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.read_file(
        str(params["path"]),
        start_line=_int_or_none(params.get("start_line")),
        end_line=_int_or_none(params.get("end_line")),
    )
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
        payload["note"] = f"中间省略 {omitted} 行；需要细节请指定更小的行范围"
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
        raise ValueError("content 为空：请提供修改后的完整文件内容")
    proposal_id = await ctx.propose(path, content, summary)
    return {"ok": True, "proposalId": proposal_id, "path": path, "summary": summary}


async def run_command(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    result = await ctx.shell.run(
        str(params["command"]),
        cwd=_str_or_none(params.get("cwd")),
        timeout_ms=_int_or_none(params.get("timeout_ms")),
    )
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
        "ok": result.ok,
    }
    if out_omitted:
        payload["stdoutOmittedLines"] = out_omitted
    if err_omitted:
        payload["stderrOmittedLines"] = err_omitted
    return _clip(payload)


async def diagram(ctx: ToolContext, params: dict[str, Any]) -> dict[str, Any]:
    """把 Mermaid 源码交给壳渲染，并挂到本轮助手消息上。"""
    if ctx.diagram is None:
        raise RuntimeError("当前 agent 不支持画图")
    kind = str(params.get("kind") or "").strip().lower()
    if kind not in {"flowchart", "sequence", "class", "state", "er"}:
        raise ValueError("kind 必须是 flowchart / sequence / class / state / er")
    source = str(params.get("source") or "").strip()
    # 容忍模型把围栏也传进来
    source = re.sub(r"^```[a-zA-Z]*\s*\n?", "", source)
    source = re.sub(r"\n?```\s*$", "", source).strip()
    if not source:
        raise ValueError("source 不能为空")
    if len(source) > 8_000:
        raise ValueError(f"图太大（{len(source)} 字符）；请压缩到 8000 字符以内、节点 ≤ 20")
    lowered = source.lower()
    if "<script" in lowered or "javascript:" in lowered:
        raise ValueError("图里不能包含脚本或 javascript: 链接")
    title = str(params.get("title") or "").strip()[:80]
    payload = {
        "id": f"d_{uuid.uuid4().hex[:8]}",
        "kind": kind,
        "title": title,
        "source": source,
    }
    ctx.diagram(payload)
    return {
        "ok": True,
        "id": payload["id"],
        "kind": kind,
        "title": title,
        "note": "已渲染。请在图后补充 3-5 行结论，不要只给一张图。",
    }


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
