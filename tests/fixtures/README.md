# Bee Code Skill & MCP Test Fixtures

These fixtures are intentionally tiny and local; they do not call the network.

## 1. Test skill loading

Folder:

```text
tests/fixtures/skills/hello-skill/
└─ SKILL.md
```

In VS Code:

1. Open **Bee Code → Skills & MCP**.
2. Drag `hello-skill` into the **Skills** drop zone, or use **Choose skill folder…**.
3. Confirm the skill appears in the list.
4. Send:

```text
Use hello-skill and follow its instructions.
```

Expected reply starts with:

```text
SKILL-OK
```

and then has exactly three bullets.

If it does not work:

- Open **Bee Code: Show logs** and check `read_skill`;
- Confirm `.beecode/skills/hello-skill/SKILL.md` exists in the workspace;
- Make sure the skill was not deleted from the view.

## 2. Test MCP loading

Files:

```text
tests/fixtures/mcp/
├─ echo_server.py
└─ mcp.json
```

`echo_server.py` is a stdio MCP server with three tools:

```text
echo(text)
add(a, b)
server_info()
```

Before using `mcp.json`, replace the `args` path with the **absolute path** to
`echo_server.py` on your machine, and replace `"python"` with your Python path if
needed. Example:

```json
{
  "mcpServers": {
    "echo": {
      "command": "D:/APP/conda/envs/beeagent/python.exe",
      "args": ["D:/APP/code_agent/tests/fixtures/mcp/echo_server.py"]
    }
  }
}
```

Then:

1. Open **Bee Code → Skills & MCP**.
2. Drag `mcp.json` into the MCP drop zone, or use **Choose mcp.json…**.
3. Confirm the server appears in the list.
4. Send:

```text
Use the echo MCP tool to echo "hello bee code".
```

Expected:

- logs show `MCP server echo ready: 3 tools`;
- the model can call `mcp__echo__echo`;
- result contains `hello bee code`.

Try the other tools:

```text
Use the add MCP tool to add 19 and 23.
```

Expected result: `42`.

```text
Call the server_info MCP tool.
```

Expected: `bee-echo` / `1.0.0`.

## 3. Cleanup

Remove the skill/server from the **Skills & MCP** view when finished. The files
under `.beecode/` are workspace-local; `.beecode/mcp.json` is gitignored.