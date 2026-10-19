"""会话状态：内核里"一轮对话"的全部可变数据。

和壳侧的关系：
  - 壳持久化完整 transcript（`<globalStorage>/sessions/*.jsonl`）；
  - 内核只持有**当前会话**的内存副本，并从 `chat.send` 收到 `history` / `summary`
    （壳已经裁剪过，不是全量历史）。
所以这里不做持久化，也不做裁剪——那是壳的职责（`sessionStore.ts` / `contextBuilder.ts`）。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

Mode = Literal["chat", "builder", "debugger"]


@dataclass(slots=True)
class Session:
    """一个会话的内存状态。"""

    id: str
    mode: Mode = "chat"
    model_config: dict[str, Any] = field(default_factory=dict)
    #: 密钥只在内存，不落盘、不进日志
    api_key: str | None = None
    created_at: float = field(default_factory=time.time)
    #: OpenAI 兼容格式：{"role": "user"|"assistant"|"system", "content": str}
    messages: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def create(cls, session_id: str, mode: Mode, model_config: dict[str, Any], api_key: str | None) -> "Session":
        return cls(id=session_id, mode=mode, model_config=dict(model_config), api_key=api_key)

    # ───────────────────────── 消息 ─────────────────────────

    def add_user(self, text: str, attachments: list[dict[str, Any]] | None = None) -> None:
        """追加一条用户消息；附件拼成可读文本块（M1 不做多模态）。"""
        content = text
        if attachments:
            blocks: list[str] = []
            for item in attachments:
                path = item.get("path") or ""
                start = item.get("startLine")
                end = item.get("endLine")
                untitled = item.get("untitled")
                where = f"{path}" if path else "（未命名）"
                if start and end:
                    where += f" 第 {start}-{end} 行"
                if untitled:
                    where += "（未保存）"
                body = item.get("text") or ""
                blocks.append(f"【用户附加的代码】{where}\n```\n{body}\n```")
            content = "\n\n".join([text, *blocks]) if text else "\n\n".join(blocks)
        self.messages.append({"role": "user", "content": content})

    def add_assistant(self, text: str) -> None:
        self.messages.append({"role": "assistant", "content": text})

    def add_system(self, text: str) -> None:
        self.messages.append({"role": "system", "content": text})

    # ───────────────────────── 供模型使用 ─────────────────────────

    def build_request_messages(
        self,
        system_prompt: str,
        *,
        history: list[dict[str, str]] | None = None,
        summary: str | None = None,
        user_text: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """组装这一轮发给模型的消息。

        顺序（与壳侧 `contextBuilder` 的分层对应）：
          1. system_prompt：模式提示词
          2. summary：早前对话摘要（壳压缩过的 L1）
          3. history：最近若干条逐字消息（壳裁剪过的 L2）
          4. user_text：本轮输入（含附件文本）
        """
        out: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
        if summary:
            out.append({"role": "system", "content": f"[早前对话摘要]\n{summary}"})
        for item in history or []:
            role = item.get("role")
            text = item.get("text")
            if role in ("user", "assistant", "system") and isinstance(text, str) and text:
                out.append({"role": role, "content": text})
        if user_text is not None or attachments:
            # 复用 add_user 的格式化逻辑，但**不写进会话历史**（避免重复：历史由壳维护）
            formatted = _format_user_content(user_text or "", attachments or [])
            out.append({"role": "user", "content": formatted})
        return out


def _format_user_content(text: str, attachments: list[dict[str, Any]]) -> str:
    if not attachments:
        return text
    blocks: list[str] = []
    for item in attachments:
        path = item.get("path") or ""
        start = item.get("startLine")
        end = item.get("endLine")
        where = path or "（未命名）"
        if start and end:
            where += f" 第 {start}-{end} 行"
        if item.get("untitled"):
            where += "（未保存）"
        body = item.get("text") or ""
        blocks.append(f"【用户附加的代码】{where}\n```\n{body}\n```")
    return "\n\n".join([text, *blocks]) if text else "\n\n".join(blocks)


def new_session_id() -> str:
    return f"s_{uuid.uuid4().hex[:12]}"
