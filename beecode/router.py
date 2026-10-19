"""意图与任务规模识别（auto 模式用）。

为什么用启发式而不是再调一次模型：
  - 每次提问都多一次模型调用，延迟与成本都翻倍；
  - 分类错了代价很小（只是换了提示词侧重，工具集相同），不值得付这个钱；
  - 规则可读、可测、可调，出问题能一眼定位。

边界：拿不准时归到 `chat`（最保守，不会自动进入"改代码"的语气）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

Mode = str  # "chat" | "builder" | "debugger"

_BUILD = re.compile(
    r"(实现|添加|新增|创建|写一个|写个|生成|重构|改成|改为|换成|替换|删除|移除|"
    r"加上|补上|补全|迁移|升级|接入|封装|抽出来|拆分|"
    r"implement|add|create|refactor|rename|remove|migrate|upgrade|rewrite)",
    re.IGNORECASE,
)
_DEBUG = re.compile(
    r"(报错|错误|异常|崩溃|失败|不工作|没反应|不生效|无法|不能|挂了|白屏|"
    r"bug|error|exception|crash|fail|broken|traceback)",
    re.IGNORECASE,
)
_EXPLAIN = re.compile(
    r"(解释|说明|讲解|介绍|什么意思|是什么|做什么|怎么理解|原理|为什么|区别|对比|"
    r"explain|what is|why|how does|difference)",
    re.IGNORECASE,
)
_LARGE = re.compile(
    r"(整个|全部|所有|批量|全量|重构|迁移|架构|设计|模块|系统|框架|从零|端到端|"
    r"多个文件|所有文件|整体|"
    r"entire|whole|all files|architecture|refactor|migrate|end.to.end)",
    re.IGNORECASE,
)
_FILE_HINT = re.compile(r"[\w\-/]+\.(ts|tsx|js|jsx|py|go|rs|java|kt|cs|cpp|c|h|md|json|yaml|yml)")


@dataclass(slots=True)
class Intent:
    mode: Mode
    scale: str  # "small" | "large"
    reason: str

    @property
    def should_plan(self) -> bool:
        return self.scale == "large"


def classify(text: str, history: list[dict[str, str]] | None = None) -> Intent:
    """根据本轮输入 + 最近历史判断模式与规模。"""
    question = (text or "").strip()
    recent = " ".join(str(item.get("text") or "") for item in (history or [])[-4:])
    haystack = f"{recent}\n{question}"

    has_code = "```" in question or bool(_FILE_HINT.search(question))
    debug_hit = bool(_DEBUG.search(question))
    build_hit = bool(_BUILD.search(question))
    explain_hit = bool(_EXPLAIN.search(question))

    # 1) 明确的报错/异常 → debugger（即使同时出现"修改"）
    if debug_hit and not explain_hit:
        mode, reason = "debugger", "检测到报错/异常描述"
    # 2) 明确的改代码意图（有代码块/文件名时更确定）
    elif build_hit:
        mode, reason = "builder", "检测到修改/实现类意图" + ("（附代码）" if has_code else "")
    # 3) 解释类
    elif explain_hit:
        mode, reason = "chat", "检测到解释/问答意图"
    else:
        mode, reason = "chat", "未检测到明确动作意图，按问答处理"

    scale = _scale(question, haystack)
    return Intent(mode=mode, scale=scale, reason=reason)


def _scale(question: str, haystack: str) -> str:
    """任务规模：长描述、涉及多个文件、或出现"整个/重构/迁移"等词 → large。"""
    if len(question) >= 240:
        return "large"
    if len(_FILE_HINT.findall(question)) >= 3:
        return "large"
    if _LARGE.search(question) or _LARGE.search(haystack):
        return "large"
    if question.count("\n") >= 8:
        return "large"
    return "small"
