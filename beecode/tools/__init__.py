"""工具定义与分发。

工具是 loop 的"手"：模型只能通过它们改变世界。
每个工具必须满足：
  1. 有清晰的 JSON Schema（模型看得到）
  2. 返回**紧凑的 dict**（会被塞回上下文，不能太大）
  3. 出错时抛异常，由 loop 统一转成 tool 消息（不要把异常抛给壳）
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ..shell import ShellClient


@dataclass(slots=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(slots=True)
class ToolContext:
    """执行工具时需要的一切外部能力（由 loop 注入）。"""

    shell: ShellClient
    #: 生成提案：path, content, summary → proposal id
    propose: Callable[[str, str, str], Awaitable[str]]
    #: 写内核日志（stderr）
    log: Callable[[str], None]
    #: 派生子代理：task, max_steps → 结论（None = 当前 agent 不允许派生子代理）
    spawn: Callable[[str, int], Awaitable[dict[str, Any]]] | None = None
    #: 更新计划（渲染到面板）
    plan: Callable[[list[dict[str, str]]], None] | None = None
    #: 生成一张图（渲染到面板，并挂到本轮助手消息上）
    diagram: Callable[[dict[str, Any]], None] | None = None


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


#: 子代理只能用的只读工具（没有 propose_edit / spawn_subagent / update_plan）
READ_ONLY_TOOLS = (
    "read_file",
    "list_files",
    "search_code",
    "file_outline",
    "find_symbol",
    "find_references",
    "get_diagnostics",
    "run_command",
)


def build_tools(role: str = "main", *, allow_spawn: bool = True) -> dict[str, Tool]:
    """按角色注册工具。

    - main：全部 10 个（含 `spawn_subagent`）
    - subagent：只读 8 个（`run_command` 由壳侧策略限制为只读命令）
    """
    from . import builtin

    specs = [
        ToolSpec(
            "read_file",
            "读取工作区内的文件（可指定行范围）。返回 text / totalLines / 行号范围。",
            _obj(
                {
                    "path": _str("工作区相对路径，例如 src/index.ts"),
                    "start_line": _int("起始行（1-based，可选）"),
                    "end_line": _int("结束行（1-based，可选）"),
                },
                ["path"],
            ),
        ),
        ToolSpec(
            "list_files",
            "列出工作区文件（已过滤 .gitignore / node_modules）。",
            _obj({"glob": _str('可选 glob，例如 "src/**/*.ts"'), "max_results": _int("最多返回多少个（默认 500）")}),
        ),
        ToolSpec(
            "search_code",
            "按关键词或正则搜索代码。filesOnly=true 时只返回文件与命中次数（省 token）。",
            _obj(
                {
                    "query": _str("搜索内容"),
                    "regex": _bool("是否按正则解释"),
                    "glob": _str("限定文件范围"),
                    "files_only": _bool("只返回文件列表（召回阶段用）"),
                    "max_results": _int("最多多少条（默认 50）"),
                },
                ["query"],
            ),
        ),
        ToolSpec(
            "file_outline",
            "列出某个文件里的函数/类及其行号范围（不读内容）。",
            _obj({"path": _str("文件路径")}, ["path"]),
        ),
        ToolSpec(
            "find_symbol",
            "在全工作区按名字查找符号定义。返回 path/name/kind/行范围。",
            _obj({"query": _str("符号名（支持部分匹配）"), "max_results": _int("最多多少条（默认 30）")}, ["query"]),
        ),
        ToolSpec(
            "find_references",
            "查找某个符号被引用的位置。",
            _obj(
                {"path": _str("文件路径"), "symbol": _str("符号名（如 parseConfig 或 ConfigParser.parse）")},
                ["path", "symbol"],
            ),
        ),
        ToolSpec(
            "get_diagnostics",
            "读取 LSP 诊断（编译错误/告警）。诊断为空不代表代码没问题。",
            _obj({"path": _str("可选：只看这个文件")}),
        ),
        ToolSpec(
            "propose_edit",
            "提交一份文件修改提案（用户逐文件审批后才落盘）。content 是**修改后的完整文件内容**。",
            _obj(
                {
                    "path": _str("工作区相对路径"),
                    "content": _str("修改后的完整文件内容"),
                    "summary": _str("一句话说明改了什么"),
                },
                ["path", "content"],
            ),
        ),
        ToolSpec(
            "update_plan",
            "更新任务计划（大任务先列 3-6 步，之后逐项更新状态）。面板会显示成清单。"
"收尾前务必再把最后一步（总结）标为 done。",
            _obj(
                {
                    "steps": {
                        "type": "array",
                        "description": "完整步骤列表（每次传全量，用来覆盖状态）",
                        "items": _obj(
                            {
                                "text": _str("步骤描述"),
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
            "把复杂代码结构画成图（Mermaid）。只在文字难以说清时使用。\n"
            "kind: flowchart（控制流/架构）| sequence（调用时序）| class（类型关系）| state（状态机）| er（数据模型）。\n"
            "source 传完整 Mermaid 源码，不要带 ```mermaid 围栏；节点 ≤ 20 个，标签 ≤ 40 字符；"
            "不要写颜色/主题/click/外链。\n"
            "图会渲染在回答里，图后必须给 3–5 行文字结论，不要只丢一张图。\n"
            "如果语法没把握或渲染失败，改用 ASCII/Unicode 图，并在正文说明。",
            _obj(
                {
                    "kind": {"type": "string", "enum": ["flowchart", "sequence", "class", "state", "er"]},
                    "source": _str("完整 Mermaid 源码（不含围栏）"),
                    "title": _str("可选：图标题"),
                },
                ["kind", "source"],
            ),
        ),
        ToolSpec(
            "spawn_subagent",
            "派一个只读子代理去探索代码（独立上下文，只回传结论）。适合大范围搜索/阅读，"
            "避免污染主对话。子代理不能改文件、不能派孙代理。",
            _obj(
                {
                    "task": _str("给子代理的任务，写清楚要找什么、要回答什么"),
                    "max_steps": _int("子代理最多几步（默认 8，上限 12）"),
                },
                ["task"],
            ),
        ),
        ToolSpec(
            "run_command",
            "在工作区内执行命令（受权限/沙箱约束，可能需要用户批准）。用于跑测试、构建、查看状态。",
            _obj(
                {
                    "command": _str("要执行的命令"),
                    "cwd": _str("工作区相对目录（可选）"),
                    "timeout_ms": _int("超时毫秒（默认 120000）"),
                },
                ["command"],
            ),
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
        "run_command": builtin.run_command,
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
