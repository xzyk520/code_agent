English | [中文](README.md)

<p align="center"><img src="media/icon-128.png" width="88" height="88" alt="Bee Code icon"></p>

# Bee Code

> **A code agent VS Code extension that brings its own model.** Three modes — Chat / Builder / Debugger — on one OpenAI-compatible protocol. Every change is first previewed as a **virtual-file proposal**, file by file; nothing hits disk until you accept it, and an entire turn can always be restored.

**Status**: `v0.1.0` · shell and core usable end to end; Python-side distribution still in progress · MIT

---

## What it solves

| Pain point | How Bee Code handles it |
| --- | --- |
| You can only use the models/subscriptions a vendor bundles | Fill in your own `model` / `api_key` / `base_url`; any OpenAI-compatible endpoint works: OpenAI, DeepSeek, Qwen, Kimi, GLM, OpenRouter, Ollama, vLLM, one-api gateways… |
| One prompt for everything, so explain/generate/fix are all mediocre | Three modes, each with its own prompts, its own tool set, and its own "what am I allowed to do" constraints |
| You only find out an edit is broken after the AI writes it | Changes become **proposals** first: source files stay untouched until accepted, with per-file `Accept`/`Reject`; shadow-git checkpoints act as a safety net for a whole-turn `Restore` |
| The AI can't see the code that is relevant to *this* question | File inventory index + keyword/symbol search + tool-driven, on-demand deep reads |
| Changing a snippet means copy-pasting it into a chat box | Select and ask: `Ctrl+Alt+K/B/D` jumps straight into Chat / Builder / Debugger |

**No backend, no relay, no telemetry**: the API key lives only in VS Code `SecretStorage` (the OS credential store), and requests go straight to the `base_url` you configured.

## Language

Use `beeCode.ui.language` (`en` by default, or `zh`) to switch the panel, hints, notifications and logs. Model-facing prompts and tool descriptions are English-only; model replies follow the language of your request.

## Architecture at a glance

```
┌─ Webview panel (media/panel.js, plain browser JS)
├─ Thin TS shell (src/)      commands · panel host · SecretStorage · WorkspaceEdit · QuickDiff · shadow git
│        ⇅  JSON-RPC 2.0 over stdio (NDJSON framing)
├─ Python core (beecode/)   AgentLoop · prompts · context · tools · patches · guards
└─ model endpoint (your own base_url)
```

The shell only does "VS Code world" work; the core never imports `vscode` — so the agent logic can be unit-tested without the editor, and can drive a CLI as well. Full design: [docs/architecture.en.md](docs/architecture.en.md).

## Skills & MCP

The **Skills & MCP** view in the sidebar accepts dropped or selected files:

- Skill folders containing `SKILL.md` are installed under `.beecode/skills/`.
- `mcp.json` is installed as `.beecode/mcp.json`.

Skill metadata is added to the system-prompt index; the model loads a skill with `read_skill`. MCP stdio servers start per turn and their tools are exposed as `mcp__<server>__<tool>`.

Example `mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

## Bundled Python

A packaged build can ship a Windows Python runtime so users do not install Python:

```powershell
npm run bundle:python
```

Windows uses the official embeddable distribution; macOS/Linux use python-build-standalone:

```text
runtime/win32-x64/python.exe
runtime/darwin-arm64/bin/python3
runtime/linux-x64/bin/python3
```

Package per platform:

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

Outputs:

```text
dist-vsix/bee-code-0.1.0-win32-x64.vsix
dist-vsix/bee-code-0.1.0-darwin-arm64.vsix
dist-vsix/bee-code-0.1.0-linux-x64.vsix
```

Each VSIX contains only its platform runtime. The `release-vsix.yml` GitHub Actions workflow builds all three on their native runners. `runtime/` and `dist-vsix/` are gitignored but included in the VSIX.

With `beeCode.core.pythonPath = "auto"` the extension prefers the bundled runtime, then falls back to system Python. Building the runtime requires network access; end users do not need Python or pip.

## Quick start

```bash
npm install            # shell dependencies
npm run build          # esbuild → dist/extension.js (dev build with inline sourcemap)
npm run typecheck      # tsc --noEmit + panel-side checkJs; must be run separately (esbuild doesn't type-check)
```

1. Open this repository in VS Code and press **F5** → a new "Extension Development Host" window opens;
2. In that window run the command **`Bee Code: Configure model (base_url / key / model)`** and fill in `base_url` / `model` / `api_key` in turn (the key goes into `SecretStorage`, never into `settings.json`);
   The summary model can be configured separately with **`Bee Code: Configure summary model`** (leave it empty to reuse the main model);
3. Click the Bee Code icon in the activity bar to open the panel.

### Only working on the shell, without the core?

Set `beeCode.core.mode` to `mock`; the extension then uses a built-in fake core so you can exercise streaming output, the pending-review list, and the stop button.

### Wiring up the real core

The core (`beecode/`) is a Python package that runs the agent loop, tool execution, proposals, and summaries. Development environment:

```bash
conda activate beeagent          # Python 3.11; any venv works
pip install -e ".[dev]"          # httpx / pydantic / pytest
```

The shell locates the core automatically in this order (`PYTHONPATH` is injected, `cwd` defaults to the workspace root):

```
beeCode.core.coreRoot (explicit)  →  <workspace root>/beecode  →  <extension dir>/beecode
```

Manual smoke test (no VS Code needed):

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"workspaceRoots":[],"modelConfig":{}}}' \
  | python -m beecode
```

## Tech stack

| Part | Choice | Notes |
| --- | --- | --- |
| Shell | TypeScript **6.0.3** (exact) | Matches the TypeScript bundled with VS Code; no `^`, or you are back to "green locally, red in the editor" |
| Types | `@types/vscode` **1.90.0** (exact) | Matches the `engines.vscode` floor, so newer APIs are rejected at compile time |
| Bundling | esbuild → single CJS file | `vscode` stays external; the production build minifies and drops sourcemaps |
| Core | Python 3.11 + httpx + pydantic | No VS Code dependency; runs and tests on its own |
| Protocol | JSON-RPC 2.0 / NDJSON | Same shape as LSP and MCP; you can debug it by feeding stdin by hand |

## Project status

| Part | Status |
| --- | --- |
| Extension shell (commands/panel/secrets/writes/checkpoints/RPC) | ✅ Builds, debuggable, `tsc` clean |
| Protocol and contract (`beecode/ipc.py` + `shell.py` + `protocol/contract.json`) | ✅ Bidirectional RPC works; both sides reconcile the contract at startup |
| Agent loop, prompts, retrieval, tools, patches, guards | ✅ Implemented (read/search/symbols/diagnostics, proposals, checkpoints, permission engine and sandbox tiers, subagents, sessions) |
| Packaging and distribution (sidecar / bootstrap) | ⬜ See [docs/development.en.md](docs/development.en.md) |
| CI (typecheck + build + pytest + vsix) | ✅ See [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |

## Docs

| Document | Contents |
| --- | --- |
| [docs/architecture.en.md](docs/architecture.en.md) | Layered design, three-mode prompts, model access and compatibility matrix, IPC contract, context engineering, write + review flow, industry comparison |
| [docs/development.en.md](docs/development.en.md) | Directory structure, roadmap, build and packaging, Python distribution options, Git workflow |
| [docs/reference.en.md](docs/reference.en.md) | Official VS Code / MCP / LSP documentation and sources for industrial practice |

## Packaging

```bash
npm run package        # → bee-code-<version>.vsix
```

`.vscodeignore` already excludes `src/`, `docs/`, `tests/`, `node_modules/`, `tools/`, `scripts/`, and `__pycache__`; `vscode:prepublish` runs `--production` (minified, no sourcemaps).

## License

[MIT](LICENSE). Issues and PRs are welcome.

- [用户验收测试 / User acceptance testing](docs/testing.md)
