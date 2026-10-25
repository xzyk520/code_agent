English | [中文](README.md)

<p align="center"><img src="media/icon-128.png" width="88" height="88" alt="Bee Code icon"></p>

# Bee Code

> **A code agent VS Code extension that brings its own model.** Three modes — Chat / Builder / Debugger — on one OpenAI-compatible protocol. Every change is first previewed as a **virtual-file proposal**, file by file; nothing hits disk until you accept it, and an entire turn can always be restored.

**Status**: `v1.0.0` · production release · Windows / macOS / Linux · MIT

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
dist-vsix/bee-code-1.0.0-win32-x64.vsix
dist-vsix/bee-code-1.0.0-darwin-arm64.vsix
dist-vsix/bee-code-1.0.0-linux-x64.vsix
```

Each VSIX contains only its platform runtime. The `release-vsix.yml` GitHub Actions workflow builds all three on their native runners. `runtime/` and `dist-vsix/` are gitignored but included in the VSIX.

With `beeCode.core.pythonPath = "auto"` the extension prefers the bundled runtime, then falls back to system Python. Building the runtime requires network access; end users do not need Python or pip.

### Cross-build macOS / Linux VSIX on Windows

If you do not want to download release assets from GitHub, you can build all
three packages locally:

```powershell
# Linux x64
$env:BEE_RUNTIME_TARGET="linux-x64"
$env:BEE_PYTHON_ARCHIVE="C:\path\cpython-3.11.17-x86_64-unknown-linux-gnu-install_only.tar.gz"
node scripts/bundle-python.mjs
node scripts/package-platform.mjs linux-x64

# macOS ARM64
$env:BEE_RUNTIME_TARGET="darwin-arm64"
$env:BEE_PYTHON_ARCHIVE="C:\path\cpython-3.11.17-aarch64-apple-darwin-install_only.tar.gz"
node scripts/bundle-python.mjs
node scripts/package-platform.mjs darwin-arm64
```

You can also let the script download through a proxy:

```powershell
$env:BEE_GITHUB_PROXY="https://gh-proxy.com"
```

The script extracts the target Python, downloads target-platform wheels with
the host Python, unpacks them into `site-packages`, removes terminfo
case collisions, and builds the target VSIX.

Always install-test the cross-built package on the real target OS before
publishing.

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
pip install -e ".[dev]"          # httpx / pydantic
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

| Area | Status |
| --- | --- |
| Extension shell (commands / panel / secrets / writes / checkpoints / RPC) | ✅ Production ready |
| Python core (agent loop, prompts, tools, compaction, guards) | ✅ Production ready |
| Proposal approval / diff preview / auto-save / checkpoint Restore | ✅ Production ready |
| Skills / MCP import and execution | ✅ Production ready |
| Windows / macOS / Linux platform VSIX | ✅ Release pipeline configured |
| Marketplace publishing | ⚠️ Requires Publisher + PAT (see docs) |

## Supported platforms

| Platform | Package | Bundled Python |
| --- | --- | --- |
| Windows x64 | `bee-code-1.0.0-win32-x64.vsix` | ✅ official embeddable |
| macOS ARM64 | `bee-code-1.0.0-darwin-arm64.vsix` | ✅ python-build-standalone |
| Linux x64 | `bee-code-1.0.0-linux-x64.vsix` | ✅ python-build-standalone |
| macOS Intel | system Python or `Set up Python core` | ⚠️ no dedicated runtime yet |

After installation the default is `beeCode.core.pythonPath = "auto"`; the packaged runtime is preferred. End users do not need Python, pip, or httpx.

## GitHub repository

Suggested About text:

```text
Description: BYO-model coding agent for VS Code. Three modes, per-file proposal approval, bundled Python, Skills and MCP.
Topics: vscode-extension, coding-agent, ai, agents, mcp, skills, deepseek, openai-compatible, typescript, python
```

The README is also the Marketplace listing body.

## Docs

- [Publishing to GitHub / Marketplace](docs/publishing.md)


| Document | Contents |
| --- | --- |
| [docs/architecture.en.md](docs/architecture.en.md) | Layered design, three-mode prompts, model access and compatibility matrix, IPC contract, context engineering, write + review flow, industry comparison |
| [docs/development.en.md](docs/development.en.md) | Directory structure, roadmap, build and packaging, Python distribution options, Git workflow |
| [docs/reference.en.md](docs/reference.en.md) | Official VS Code / MCP / LSP documentation and sources for industrial practice |

## Packaging

### Build per platform (recommended)

```bash
npm run bundle:python     # first build downloads the platform runtime
npm run package:win       # → dist-vsix/bee-code-1.0.0-win32-x64.vsix
npm run package:mac       # → dist-vsix/bee-code-1.0.0-darwin-arm64.vsix
npm run package:linux     # → dist-vsix/bee-code-1.0.0-linux-x64.vsix
```

Windows is about 19 MB with bundled Python; macOS/Linux are about 20–25 MB and must be built on their native runner.

Universal package (includes `runtime/` if present locally):

```bash
npm run package
```

`.vscodeignore` excludes `src/`, `docs/`, `node_modules/`, `scripts/`, `tools/`, and `__pycache__`; `runtime/` is included in platform packages. `vscode:prepublish` runs `--production` (minified, no sourcemaps).

## License

[MIT](LICENSE). Issues and PRs are welcome.

