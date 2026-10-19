"""Agent loop（M1：单轮对话）。

现在的循环只有一步：**用户输入 → 调模型 → 流式吐字**。
M2 会在这里加工具调用循环（tool_calls → 执行 → 结果回灌 → 继续）。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..llm import ChatDelta, ModelError, OpenAIClient, estimate_tokens
from ..prompts import system_prompt
from ..session import Session

Notify = Callable[[str, dict[str, Any]], None]


class AgentLoop:
    """一轮对话的执行者。由 `__main__.py` 创建并按会话串行调用。"""

    def __init__(self, notify: Notify) -> None:
        self._notify = notify

    async def run_turn(
        self,
        session: Session,
        *,
        text: str,
        attachments: list[dict[str, Any]],
        history: list[dict[str, str]],
        summary: str | None,
        max_steps: int = 1,
    ) -> None:
        """执行一轮。**整轮结束才返回**；进度全靠 `ui.delta` / `ui.usage`。

        `max_steps` 现在没用（只跑一次模型调用），留给 M2 的工具循环——
        参数先占位，避免以后改签名波及调用方。
        """
        del max_steps

        client = OpenAIClient(
            base_url=str(session.model_config.get("baseUrl") or ""),
            model=str(session.model_config.get("model") or ""),
            api_key=session.api_key,
        )

        messages = session.build_request_messages(
            system_prompt(session.mode),
            history=history,
            summary=summary,
            user_text=text,
            attachments=attachments,
        )

        parts: list[str] = []
        usage: dict[str, int] | None = None
        finish_reason: str | None = None

        self._emit_tool(session, "model", "start")
        try:
            async for delta in client.stream_chat(messages):
                if delta.usage:
                    usage = delta.usage
                if delta.finish_reason:
                    finish_reason = delta.finish_reason
                if delta.text:
                    parts.append(delta.text)
                    self._notify("ui.delta", {"sessionId": session.id, "text": delta.text})
        except ModelError as exc:
            # 模型层错误：留一条系统消息在会话里，壳会显示在面板上
            session.add_system(f"模型调用失败：{exc}")
            raise
        finally:
            self._emit_tool(session, "model", "end", finish_reason or "done")

        answer = "".join(parts)
        session.add_user(text, attachments)
        session.add_assistant(answer)
        self._notify(
            "ui.usage",
            {
                "sessionId": session.id,
                "inputTokens": (usage or {}).get("inputTokens") or _estimate_input(messages),
                "outputTokens": (usage or {}).get("outputTokens") or estimate_tokens(answer),
            },
        )

    # ───────────────────────── 内部 ─────────────────────────

    def _emit_tool(self, session: Session, name: str, status: str, summary: str | None = None) -> None:
        params: dict[str, Any] = {"sessionId": session.id, "name": name, "status": status}
        if summary:
            params["summary"] = summary
        self._notify("ui.tool", params)


def _estimate_input(messages: list[dict[str, Any]]) -> int:
    return sum(estimate_tokens(str(m.get("content") or "")) for m in messages)


__all__ = ["AgentLoop", "ChatDelta"]
