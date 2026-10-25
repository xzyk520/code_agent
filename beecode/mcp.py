"""Minimal stdio MCP client for user-provided servers.

Configuration: `<workspace>/.beecode/mcp.json`

```json
{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}}
```

Only the stdio transport and the `tools/list` / `tools/call` surface are supported.
Servers are started per turn and stopped when the turn ends.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

from .tools import Tool, ToolSpec


class MCPError(RuntimeError):
    pass


class MCPClient:
    def __init__(self, name: str, command: str, args: list[str], env: dict[str, str]) -> None:
        self.name = name
        self._command = command
        self._args = args
        self._env = {**os.environ, **env}
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._next_id = 1

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            self._command,
            *self._args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=self._env,
        )
        await self.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "bee-code", "version": "0.1.0"}})
        await self._notify("notifications/initialized", {})

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        if self._proc is None or self._proc.stdin is None or self._proc.stdout is None:
            raise MCPError(f"MCP server {self.name} is not running")
        async with self._lock:
            request_id = self._next_id
            self._next_id += 1
            payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            self._proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
            await self._proc.stdin.drain()
            while True:
                line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=30)
                if not line:
                    raise MCPError(f"MCP server {self.name} closed stdout")
                try:
                    message = json.loads(line.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                if message.get("id") != request_id:
                    continue
                if "error" in message:
                    raise MCPError(str(message["error"]))
                return message.get("result")

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        if self._proc is None or self._proc.stdin is None:
            return
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        self._proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()

    async def close(self) -> None:
        if self._proc is None:
            return
        try:
            self._proc.terminate()
            await asyncio.wait_for(self._proc.wait(), timeout=3)
        except Exception:
            self._proc.kill()
        self._proc = None


class MCPManager:
    def __init__(self, clients: list[MCPClient], tools: dict[str, Tool]) -> None:
        self.clients = clients
        self.tools = tools

    async def close(self) -> None:
        for client in self.clients:
            await client.close()


def _safe_name(server: str, tool: str) -> str:
    raw = f"mcp__{server}__{tool}"
    return re.sub(r"[^A-Za-z0-9_]", "_", raw)[:64]


async def load_mcp_manager(log: Any = None) -> MCPManager:
    path = Path.cwd() / ".beecode" / "mcp.json"
    if not path.is_file():
        return MCPManager([], {})
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        if log:
            log(f"MCP config parse failed: {exc}")
        return MCPManager([], {})
    servers = data.get("mcpServers") or data.get("servers") or {}
    clients: list[MCPClient] = []
    tools: dict[str, Tool] = {}
    for server_name, spec in servers.items():
        if not isinstance(spec, dict):
            continue
        command = str(spec.get("command") or "").strip()
        if not command:
            continue
        args = [str(x) for x in (spec.get("args") or [])]
        env = {str(k): str(v) for k, v in (spec.get("env") or {}).items()}
        client = MCPClient(str(server_name), command, args, env)
        try:
            await client.start()
            listed = await client.request("tools/list", {})
        except Exception as exc:
            if log:
                log(f"MCP server {server_name} failed: {exc}")
            await client.close()
            continue
        clients.append(client)
        if log:
            log(f"MCP server {server_name} ready: {len((listed or {}).get('tools', []))} tools")
        for item in (listed or {}).get("tools", []):
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            tool_name = _safe_name(str(server_name), name)
            schema = item.get("inputSchema") or {"type": "object", "properties": {}}
            description = str(item.get("description") or f"MCP tool {name} from {server_name}")

            async def call(_ctx: Any, params: dict[str, Any], _client: MCPClient = client, _tool: str = name) -> dict[str, Any]:
                result = await _client.request("tools/call", {"name": _tool, "arguments": params})
                return {"mcp": True, "result": result}

            tools[tool_name] = Tool(spec=ToolSpec(tool_name, description, schema if isinstance(schema, dict) else {}), fn=call)
    return MCPManager(clients, tools)
