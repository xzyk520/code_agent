"""Tool definitions and dispatch.

Tools are the loop's "hands": the model can only change the world through them.
Every tool must satisfy:
  1. Have a clear JSON Schema (visible to the model)
  2. Return a **compact dict** (it is fed back into the context and must not be too large)
  3. Raise on error and let the loop convert it into a tool message (never throw the exception back to the shell)
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ..shell import ShellClient


@dataclass(slots=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(slots=True)
class ToolContext:
    """All external capabilities a tool needs at execution time (injected by the loop)."""

    shell: ShellClient
    #: Create a proposal: path, content, summary, expected_version → proposal id
    propose: Callable[..., Awaitable[str]]
    #: Write a kernel log (stderr)
    log: Callable[[str], None]
    #: Spawn a subagent: task, max_steps → conclusion (None = this agent may not spawn subagents)
    spawn: Callable[[str, int], Awaitable[dict[str, Any]]] | None = None
    #: Update the plan (rendered in the panel)
    plan: Callable[[list[dict[str, str]]], None] | None = None
    #: Generate a diagram (rendered in the panel and attached to this turn's assistant message)
    diagram: Callable[[dict[str, Any]], None] | None = None
    #: Outer time limit for long tools such as command execution (seconds), used by run_command to set the RPC timeout
    long_tool_timeout_s: float = 600.0
    #: Files read this turn → version at read time; edit_file uses this for read-before-edit / conflict detection
    observed: dict[str, int | None] = field(default_factory=dict)


ToolFn = Callable[[ToolContext, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(slots=True)
class Tool:
    spec: ToolSpec
    fn: ToolFn


def _obj(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}


def _str(description: str) -> dict[str, Any]:
    return {"type": "string", "description": description}


def _int(description: str) -> dict[str, Any]:
    return {"type": "integer", "description": description}


def _bool(description: str) -> dict[str, Any]:
    return {"type": "boolean", "description": description}


#: Read-only tools available to subagents (no propose_edit / spawn_subagent / update_plan)
READ_ONLY_TOOLS = (
    "read_file",
    "list_files",
    "search_code",
    "file_outline",
    "find_symbol",
    "find_references",
    "get_diagnostics",
    "run_command",
    "command_wait",
    "command_terminate",
    "command_list",
)


def build_tools(role: str = "main", *, allow_spawn: bool = True) -> dict[str, Tool]:
    """Register tools by role.

    - main: all 10 (including `spawn_subagent`)
    - subagent: only the 8 read-only ones (`run_command` is restricted to read-only commands by the shell-side policy)
    """
    from . import builtin

    specs = [
        ToolSpec(
            "read_file",
            "Read a workspace file, optionally a line range. Returns text / totalLines / line range.",
            _obj(
                {
                    "path": _str("Workspace-relative path, e.g. src/index.ts"),
                    "start_line": _int("First line (1-based, optional)"),
                    "end_line": _int("Last line (1-based, optional)"),
                },
                ["path"],
            ),
        ),
        ToolSpec(
            "list_files",
            "List workspace files (honors .gitignore and excludes node_modules).",
            _obj({"glob": _str('Optional glob, e.g. "src/**/*.ts"'), "max_results": _int("Maximum results (default 500)")}),
        ),
        ToolSpec(
            "search_code",
            "Search code by keyword or regex. filesOnly=true returns only files and match counts to save tokens.",
            _obj(
                {
                    "query": _str("Search query"),
                    "regex": _bool("Interpret query as a regular expression"),
                    "glob": _str("Restrict to matching files"),
                    "files_only": _bool("Return only the file list (recall phase)"),
                    "max_results": _int("Maximum hits (default 50)"),
                },
                ["query"],
            ),
        ),
        ToolSpec(
            "file_outline",
            "List functions/classes and their line ranges in a file without reading its contents.",
            _obj({"path": _str("File path")}, ["path"]),
        ),
        ToolSpec(
            "find_symbol",
            "Find symbol definitions by name across the workspace. Returns path/name/kind/line range.",
            _obj({"query": _str("Symbol name (partial match supported)"), "max_results": _int("Maximum results (default 30)")}, ["query"]),
        ),
        ToolSpec(
            "find_references",
            "Find references to a symbol.",
            _obj(
                {"path": _str("File path"), "symbol": _str("Symbol name (e.g. parseConfig or ConfigParser.parse)")},
                ["path", "symbol"],
            ),
        ),
        ToolSpec(
            "get_diagnostics",
            "Read LSP diagnostics (compile errors and warnings). Empty diagnostics do not prove the code is correct.",
            _obj({"path": _str("Optional: only this file")}),
        ),
        ToolSpec(
            "propose_edit",
            "Submit a file-change proposal (the user approves each file before it is written). `content` is the complete new file.",
            _obj(
                {
                    "path": _str("Workspace-relative path"),
                    "content": _str("Complete new file content"),
                    "summary": _str("One-line summary of the change"),
                },
                ["path", "content"],
            ),
        ),
        ToolSpec(
            "edit_file",
            "Edit an existing file with old_string/new_string instead of rewriting it. "
            "Read the file first with read_file; old_string must match uniquely unless replace_all=true. "
            "The edit becomes a proposal and is written only after user approval. Use propose_edit for new files or full rewrites.",
            _obj(
                {
                    "path": _str("Workspace-relative path"),
                    "old_string": _str("Exact text to replace (include enough context for a unique match)"),
                    "new_string": _str("Replacement text; may be empty to delete"),
                    "replace_all": _bool("Replace every match (default false)"),
                    "summary": _str("Optional one-line summary"),
                },
                ["path", "old_string", "new_string"],
            ),
        ),
        ToolSpec(
            "update_plan",
            "Update the task plan. For a large task, start with 3-6 steps and update each status. "
            "The panel renders it as a checklist; mark the final summary step done before the final answer.",
            _obj(
                {
                    "steps": {
                        "type": "array",
                        "description": "Complete step list; send the full list each time",
                        "items": _obj(
                            {
                                "text": _str("Step description"),
                                "status": {"type": "string", "enum": ["pending", "doing", "done"]},
                            },
                            ["text"],
                        ),
                    }
                },
                ["steps"],
            ),
        ),
        ToolSpec(
            "diagram",
            "Render a complex code structure as a Mermaid diagram. Use only when prose is insufficient.\n"
            "kind: flowchart | sequence | class | state | er.\n"
            "Pass complete Mermaid source without a ```mermaid fence; at most 20 nodes and 40 characters per label; "
            "do not use colors, themes, click handlers, or external links.\n"
            "The diagram is rendered in the answer; follow it with 3-5 lines of text, not just the diagram.\n"
            "If the syntax is uncertain or rendering fails, use an ASCII/Unicode diagram and explain it in prose.",
            _obj(
                {
                    "kind": {"type": "string", "enum": ["flowchart", "sequence", "class", "state", "er"]},
                    "source": _str("Complete Mermaid source (no fence)"),
                    "title": _str("Optional diagram title"),
                },
                ["kind", "source"],
            ),
        ),
        ToolSpec(
            "spawn_subagent",
            "Spawn a read-only subagent to explore code in an independent context and return only its conclusion. "
            "Useful for broad search/reading without polluting the main conversation. Subagents cannot edit files or spawn further subagents.",
            _obj(
                {
                    "task": _str("Task for the subagent: what to find and what to answer"),
                    "max_steps": _int("Maximum steps for the subagent (default 8, max 12)"),
                },
                ["task"],
            ),
        ),
        ToolSpec(
            "run_command",
            "Run a command in the workspace (user approval required). There is no hard execution limit: the first call waits yield_ms (default 120s). "
            "If the command is still running, the result has status=running, jobId, elapsed time, and progress; it has moved to the background. "
            "Use command_wait to poll with your chosen interval, or command_terminate to stop it and change approach. Do not re-run the same command. "
            "Request the least privilege: sandbox-readonly by default; sandbox to write the workspace; sandbox-network for downloads/network; host only when the real system is unavoidable. "
            "Every elevation needs justification.",
            _obj(
                {
                    "command": _str("Command to run"),
                    "cwd": _str("Workspace-relative directory (optional)"),
                    "yield_ms": _int("Foreground wait in milliseconds (default 120000, max 300000); exceeding it moves the job to the background, it does not kill it"),
                    "sandbox": {
                        "type": "string",
                        "enum": ["sandbox-readonly", "sandbox", "sandbox-network", "host"],
                        "description": "Least-to-most privilege: sandbox-readonly (default, Docker read-only) < sandbox (workspace writable) < sandbox-network (network) < host (real system). Each elevation needs approval and justification.",
                    },
                    "justification": _str("Why the extra permission is needed; shown to the user for approval"),
                },
                ["command"],
            ),
        ),
        ToolSpec(
            "command_wait",
            "Poll a background command with your chosen interval. Returns all new output since the previous read, or noNewOutput=true. "
            "If status=exited it is the final result; otherwise decide whether to keep waiting or command_terminate.",
            _obj(
                {
                    "job_id": _str("jobId returned by run_command"),
                    "yield_ms": _int("Polling interval in milliseconds (default 120000, max 300000); you choose it"),
                },
                ["job_id"],
            ),
        ),
        ToolSpec(
            "command_list",
            "List background jobs for this session: job_id, command, running/exited, elapsed time, and time since last output. "
            "Use it when you lost a job_id or want to confirm what is still running.",
            _obj({}),
        ),
        ToolSpec(
            "command_terminate",
            "Stop a running run_command job and return the output collected so far plus the final status. "
            "Use it when progress stalls, the approach is wrong, or the result is no longer needed.",
            _obj({"job_id": _str("jobId returned by run_command")}, ["job_id"]),
        ),
    ]

    handlers: dict[str, ToolFn] = {
        "read_file": builtin.read_file,
        "list_files": builtin.list_files,
        "search_code": builtin.search_code,
        "file_outline": builtin.file_outline,
        "find_symbol": builtin.find_symbol,
        "find_references": builtin.find_references,
        "get_diagnostics": builtin.get_diagnostics,
        "propose_edit": builtin.propose_edit,
        "edit_file": builtin.edit_file,
        "run_command": builtin.run_command,
        "command_wait": builtin.command_wait,
        "command_terminate": builtin.command_terminate,
        "command_list": builtin.command_list,
        "spawn_subagent": builtin.spawn_subagent,
        "update_plan": builtin.update_plan,
        "diagram": builtin.diagram,
    }

    names = [spec.name for spec in specs] if role == "main" else [n for n in READ_ONLY_TOOLS]
    if not allow_spawn:
        names = [n for n in names if n != "spawn_subagent"]
    return {name: Tool(spec=next(s for s in specs if s.name == name), fn=handlers[name]) for name in names}


def tool_schemas(tools: dict[str, Tool]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {"name": t.spec.name, "description": t.spec.description, "parameters": t.spec.parameters},
        }
        for t in tools.values()
    ]
