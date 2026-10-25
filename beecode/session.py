"""Session state: all mutable data for "one conversation turn" inside the kernel.

Relationship with the shell side:
  - The shell persists the full transcript (`<globalStorage>/sessions/*.jsonl`);
  - The kernel only holds an in-memory copy of the **current session**, and receives
    `history` / `summary` from `chat.send` (the shell has already trimmed them, so they
    are not the full history).
Therefore nothing here does persistence or trimming — that is the shell's job
(`sessionStore.ts` / `contextBuilder.ts`).
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

Mode = Literal["chat", "builder", "debugger"]


@dataclass(slots=True)
class Session:
    """In-memory state of one session."""

    id: str
    mode: Mode = "chat"
    model_config: dict[str, Any] = field(default_factory=dict)
    #: The key stays in memory only: never written to disk, never logged
    api_key: str | None = None
    created_at: float = field(default_factory=time.time)
    #: OpenAI-compatible format: {"role": "user"|"assistant"|"system", "content": str}
    messages: list[dict[str, Any]] = field(default_factory=list)
    #: Intent analysis result of the previous turn (used to detect continuation)
    last_intent: dict[str, Any] | None = None
    #: Read files → version at read time; used by edit_file for read-before-edit / conflict detection
    observed_files: dict[str, int | None] = field(default_factory=dict)

    @classmethod
    def create(cls, session_id: str, mode: Mode, model_config: dict[str, Any], api_key: str | None) -> "Session":
        return cls(id=session_id, mode=mode, model_config=dict(model_config), api_key=api_key)

    # ───────────────────────── Messages ─────────────────────────

    def add_user(self, text: str, attachments: list[dict[str, Any]] | None = None) -> None:
        """Append a user message; attachments are folded into readable text blocks (M1 is not multimodal)."""
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

    # ───────────────────────── For model consumption ─────────────────────────

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
        """Assemble the messages sent to the model for this turn.

        Order (mirrors the layering of `contextBuilder` on the shell side):
          1. system_prompt: mode prompt
          2. summary: earlier conversation summary (L1, compressed by the shell)
          3. history: the most recent verbatim messages (L2, trimmed by the shell)
          4. user_text: this turn's input (including attachment text)
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
            # Reuse add_user's formatting logic, but do **not** write it into the session history (to avoid duplication: history is maintained by the shell)
            formatted = _format_user_content(user_text or "", attachments or [], vision=vision)
            out.append({"role": "user", "content": formatted})
        return out


#: Defensive attachment limits (the shell already caps them; this is the last line of defense)
MAX_ATTACHMENT_CHARS = 40_000
MAX_ATTACHMENT_TOTAL = 120_000


def _format_user_content(
    text: str,
    attachments: list[dict[str, Any]],
    *,
    vision: bool = False,
) -> str | list[dict[str, Any]]:
    """Assemble "user input + attachments" into OpenAI message content.

    - Plain-text attachments (code selections) → concatenated into the string directly
    - Image attachments: vision models get `image_url` multimodal parts; non-vision models
      degrade to a one-line textual note
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
    """Replace images in multimodal messages with a one-line textual note (used after "model does not support images").

    Modified in place; returns the same list so callers can reuse it directly.
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
