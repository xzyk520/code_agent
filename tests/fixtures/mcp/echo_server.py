#!/usr/bin/env python3
"""Small stdio MCP server for manually testing Bee Code's MCP bridge.

It uses only the Python standard library. It speaks newline-delimited JSON-RPC
2.0, which is what Bee Code's minimal stdio client expects.

Tools:
  echo(text)      -> {"echo": text}
  add(a, b)       -> {"sum": a + b}
  server_info()   -> {"name": "bee-echo", "version": "1.0.0"}
"""

from __future__ import annotations

import json
import sys
from typing import Any

TOOLS = [
    {
        "name": "echo",
        "description": "Return the provided text unchanged.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "Text to echo"}},
            "required": ["text"],
        },
    },
    {
        "name": "add",
        "description": "Add two numbers.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "a": {"type": "number", "description": "First number"},
                "b": {"type": "number", "description": "Second number"},
            },
            "required": ["a", "b"],
        },
    },
    {
        "name": "server_info",
        "description": "Return the test server name and version.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "bee-echo", "version": "1.0.0"},
            },
        }
    if method == "notifications/initialized":
        return None
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        try:
            if name == "echo":
                result = {"echo": str(arguments.get("text", ""))}
            elif name == "add":
                result = {"sum": float(arguments.get("a", 0)) + float(arguments.get("b", 0))}
            elif name == "server_info":
                result = {"name": "bee-echo", "version": "1.0.0"}
            else:
                raise ValueError(f"unknown tool: {name}")
        except Exception as exc:  # noqa: BLE001 - report tool errors through MCP
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"isError": True, "content": [{"type": "text", "text": str(exc)}]},
            }
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": json.dumps(result)}]},
        }
    return None


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = handle(message)
        if response is not None:
            print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()