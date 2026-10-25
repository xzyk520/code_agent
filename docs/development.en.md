English | [中文](development.md)

# Development

> English overview. The exhaustive, maintained document is [development.md](development.md) (Chinese).

## Repository layout

```text
src/                 VS Code extension shell (TypeScript)
  adapters/          VS Code capabilities exposed over JSON-RPC
  panel/             webview host and panel state
  rpc/               NDJSON JSON-RPC transport
  commands/          command-palette registration
media/               panel.js, CSS, vendored Mermaid/highlight.js
beecode/             Python core (agent loop, prompts, tools, protocol)
protocol/            shared contract.json
docs/                architecture, development, reference
```

## Local development

```bash
npm install
npm run build
npm run typecheck
```

Press F5 in VS Code to launch an Extension Development Host. Run **Bee Code: Configure model (base_url / key / model)** and fill in an OpenAI-compatible endpoint.

Python core:

```bash
conda activate beeagent
pip install -e ".[dev]"
python -m beecode
```

`beeCode.core.coreRoot` controls where the shell looks for `beecode/`; `beeCode.core.pythonPath` selects the interpreter.

## Tests and checks

- `npm run typecheck` — TypeScript shell and webview JS type checking.
- `python -m compileall -q beecode` — Python syntax check.
- Shell lifecycle smoke tests are run against the built `dist/extension.js` with a VS Code API mock.
- No network or real model is required for protocol/tool tests.

## Packaging

```bash
npm run package
```

`vscode:prepublish` uses esbuild production mode. `.vscodeignore` excludes `src/`, `docs/`, `tests/`, and `node_modules/`.

## Python distribution

Installed builds must ship the `beecode/` package. The shell resolves it from:

```text
beeCode.core.coreRoot → workspace/beecode → extension/beecode
```

For a store build, package the Python runtime and core as a sidecar; see the Chinese document for the current distribution plan.

## Git workflow

- Keep commits focused; each user-visible behavior change gets one commit.
- Run typecheck, Python compile, and build before committing.
- Do not commit `dist/`, `node_modules/`, or local session data.
