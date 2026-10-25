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
    #: 上一轮的意图分析结果（供下一轮判断是否延续）
    last_intent: dict[str, Any] | None = None
    #: 已读文件 → 读取时 version；edit_file 的 read-before-edit / 冲突检测
    observed_files: dict[str, int | None] = field(default_factory=dict)

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

    def add_assistant(self, text: str, diagrams: list[dict[str, Any]] | None = None) -> None:
        message: dict[str, Any] = {"role": "assistant", "content": text}
        if diagrams:
            message["diagrams"] = list(diagrams)
        self.messages.append(message)

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
        vision: bool = False,
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
            if role not in ("user", "assistant", "system") or not isinstance(text, str) or not text:
                continue
            diagrams = item.get("diagrams") or []
            if role == "assistant" and diagrams:
                fences = "\n\n".join(
                    f"[图：{d.get('kind') or 'mermaid'} {d.get('title') or ''}]\n```mermaid\n{d.get('source') or ''}\n```"
                    for d in diagrams
                    if isinstance(d, dict) and d.get("source")
                )
                text = f"{text}\n\n{fences}".strip()
            out.append({"role": role, "content": text})
        if user_text is not None or attachments:
            # 复用 add_user 的格式化逻辑，但**不写进会话历史**（避免重复：历史由壳维护）
            formatted = _format_user_content(user_text or "", attachments or [], vision=vision)
            out.append({"role": "user", "content": formatted})
        return out


#: 附件防御性上限（壳已限制，这里是最后一道）
MAX_ATTACHMENT_CHARS = 40_000
MAX_ATTACHMENT_TOTAL = 120_000


def _format_user_content(
    text: str,
    attachments: list[dict[str, Any]],
    *,
    vision: bool = False,
) -> str | list[dict[str, Any]]:
    """把"用户输入 + 附件"拼成 OpenAI 消息内容。

    - 纯文本附件（代码选区）→ 直接拼进字符串
    - 图片附件：视觉模型转成 `image_url` 多模态片段；非视觉模型降级成一行文字说明
    """
    if not attachments:
        return text

    blocks: list[str] = []
    images: list[dict[str, Any]] = []
    for item in attachments:
        image = item.get("imageBase64")
        if isinstance(image, str) and image:
            if vision:
                mime = item.get("mimeType") or "image/png"
                images.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image}"}})
            else:
                where = item.get("path") or "（粘贴的图片）"
                blocks.append(f"【图片已省略】{where}：当前模型不支持图像输入")
            continue

        path = item.get("path") or ""
        start = item.get("startLine")
        end = item.get("endLine")
        where = path or "（未命名）"
        if start and end:
            where += f" 第 {start}-{end} 行"
        if item.get("untitled"):
            where += "（未保存）"
        body = str(item.get("text") or "")
        if len(body) > MAX_ATTACHMENT_CHARS:
            body = body[:MAX_ATTACHMENT_CHARS] + "\n…（附件已截断）"
        if item.get("kind") == "focus":
            header = f"【光标附近的代码】{where}"
            symbol = item.get("symbol")
            if symbol:
                header += f" · 函数 {symbol}"
            blocks.append(f"{header}\n```\n{body}\n```")
        else:
            blocks.append(f"【用户附加的代码】{where}\n```\n{body}\n```")

    text_part = "\n\n".join([text, *blocks]) if text else "\n\n".join(blocks)
    if len(text_part) > MAX_ATTACHMENT_TOTAL:
        text_part = text_part[:MAX_ATTACHMENT_TOTAL] + "\n…（附件总量超限，已截断）"
    if not images:
        return text_part
    return [{"type": "text", "text": text_part}, *images]


def strip_image_parts(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把多模态消息里的图片换成一行文字说明（用于"模型不支持图片"后的重试）。

    就地修改并返回同一个列表，方便调用方直接复用。
    """
    note = "【图片已省略：当前模型不接受图像输入】"
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        texts: list[str] = []
        had_image = False
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "image_url":
                had_image = True
            elif part.get("type") == "text" and isinstance(part.get("text"), str):
                texts.append(str(part["text"]))
        if had_image:
            joined = "\n\n".join([t for t in texts if t.strip()])
            message["content"] = f"{joined}\n\n{note}".strip() if joined else note
    return messages


def has_image_parts(messages: list[dict[str, Any]]) -> bool:
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        if any(isinstance(part, dict) and part.get("type") == "image_url" for part in content):
            return True
    return False


def new_session_id() -> str:
    return f"s_{uuid.uuid4().hex[:12]}"
