English | [中文](architecture.md)

# Bee Code Architecture Design

> This is the detailed design document split out of the [README](../README.en.md): goals, layers, the three modes, model access, the agent loop, context engineering, landing changes, and the industry comparison.
> Section numbers stay consistent with earlier README versions, so internal anchors (e.g., §4.5, §10.6) can be jumped to directly within this file.

## 0. Document notes

- This document describes the overall architecture of the **v0.0.x design phase**; it is revised continuously alongside the implementation. Interfaces are defined by the code; this document is defined by "why it is designed this way".
- Markers: 🧭 decided ｜ 🔬 to be validated during implementation (PoC) ｜ 🧪 experimental / optional.
- This document is also a **research-conclusions document**: wherever possible, every key design point cites the corresponding industry practice and its source (see [§14](#14-industry-reference) and [§20 References](./reference.en.md#20-references)).
- Project naming: repository `bee-code`, extension ID `<publisher>.bee-code`, display name `Bee Code`, command prefix `beeCode.`, settings namespace `beeCode.*`, in-project data directory `.beecode/`, virtual document scheme `beecode-xzyk520-base:` (publisher-prefixed to avoid clashing with other extensions).
- Revision: **starting with v0.3, landing changes uses "proposal (virtual file) → per-file approval → write to disk"**: the corrected content from the core is previewed as a virtual file first, and only written to disk once the user accepts. Rationale in [§14.10](#1410-why-we-ultimately-chose-per-file-approval-proposal-mode), design in [§10](#10-landing-changes-proposals--per-file-approval-proposal-then-apply).
- Tech stack (decided in v0.2): **Python core + TypeScript thin shell**. VS Code extension APIs are only available in TS/JS (the Extension Host is Node.js), so Python cannot be an extension language; therefore all agent logic (loop / retrieval / prompts / patches / protocol) lives in a Python subprocess, and the TS shell only does editor integration. Contract in [§4.5](#45-shell--core-ipc-contract-json-rpc-20-over-stdio), distribution plan in [§17.1](./development.en.md#171-python-runtime-distribution-the-biggest-cost-of-option-a-decide-early).
- License: **MIT** (see [LICENSE](../LICENSE)).

---

## 1. Project positioning

### 1.1 In one sentence

Put "an AI pair programmer that understands your whole project, can explain, can write, and can fix" inside VS Code, with the **model entirely chosen by the user** and **every change shown to you first**.

### 1.2 Problems to solve

| Pain point | This project's answer |
| --- | --- |
| Cloud subscription lock-in: you can only use the vendor's own models/subscriptions | Users fill in their own `model` / `api_key` / `base_url`; any OpenAI-compatible endpoint (official, DeepSeek, Qwen, Kimi, GLM, OpenRouter, Ollama, vLLM, one-api gateways…) |
| One prompt for everything: explain, generate, and fix bugs all use the same prompt, so none of them is great | Three modes with independent prompts + independent tool sets + independent "what is allowed" constraints |
| The AI edits files directly, and you only notice the damage afterwards | Changes are first turned into **virtual-file proposals**: the source file is untouched until "accepted"; a whole turn can also be rolled back with `Restore` |
| The AI cannot see the code "relevant to your question" | Three-level retrieval: file inventory → keyword/symbol search → tool-driven, on-demand deep reads |
| Changing a piece of code means copy-pasting it into a chat box | Select and ask: right-click / keyboard shortcut jumps straight into Chat, Builder, or Debugger |
| You do not know which files the AI actually touched | One proposal card per file, red/green side-by-side diff plus a one-sentence explanation; accept/reject individually, or all at once |

### 1.3 Non-goals (explicitly out of scope for v1)

- ❌ No hosted backend, no relaying of user requests, no code collection (**there is no server**; keys and code only travel between this machine and the model endpoint the user specified).
- ❌ No attempt to replace the IDE (no takeover of completion, no full LSP implementation).
- ❌ No unattended / YOLO fully automatic mode without approval (could be a 🧪 advanced switch, off by default and requiring explicit double confirmation).
- ❌ No ambition to support every language at once; the first release focuses on TS/JS/Python/Go/Java/Rust — languages with mature LSP symbol support.
- ❌ **No web extension** (vscode.dev / github.dev): the core is a Python subprocess, and there is no `browser` entry point. That is the definite cost of the "Python core" route.

---

## 2. Design principles

1. **Write-then-Review**: model writes land immediately and are registered as "pending review"; "rollback-ability" is guaranteed by checkpoints + reverse patches, not by intercepting writes.
2. **User holds the keys**: API keys go into `SecretStorage` (the OS-level encrypted credential store), never into `settings.json`, logs, or git.
3. **One wire format**: internally there is only one model protocol — the OpenAI Chat Completions compatible format; differences between vendors are absorbed in the adapter layer.
4. **Every step is visible**: every tool call, every retrieval hit, and every token spent can be replayed in the panel.
5. **Always cancellable**: an `AbortSignal` can stop the loop at any moment, without leaving a half-written file.
6. **Core and UI decoupled**: agent logic lives in the **Python core** and talks to the TS shell over JSON-RPC; the core does not know `vscode`, so it can run unit tests outside the editor and can be attached to a CLI directly.

---

## 3. Glossary

| Term | Meaning |
| --- | --- |
| **Mode** | Chat / Builder / Debugger; determines the prompt, the available tool set, and the output contract |
| **Agent Loop** | The iterative process of `assemble context → call model → parse tool calls → execute tools → feed results back → call model again` |
| **Tool** | A callable function exposed to the model, with parameters described by JSON Schema; classified as read-only / write / execute |
| **Proposal (virtual file)** | The "corrected full file content" produced by the core; it exists only in memory until accepted. Metadata is broadcast via `proposal.changed`, and the body is fetched on demand via `proposal.read` |
| **Checkpoint** | A snapshot in a shadow git repository, used for whole-turn rollback via `Restore` |
| **Accept / Reject** | Review verbs: `Accept` writes the proposal into the source file (the only write moment); `Reject` discards the proposal with zero changes on disk |
| **Hunk** | One `@@ ... @@` block in a unified diff; the smallest unit rendered by the diff editor |
| **Function Unit** | An **optional** grouping that merges several hunks into their enclosing function/method (extension point, currently disabled; see §11.4) |
| **Context Budget** | The token quota allocated proportionally to system prompt, retrieval, history, and output |

---

## 4. Overall architecture

### 4.1 Layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L1  UI layer (VS Code native + Webview)                                   │
│  Chat/Agent panel · selection context menu · keybindings · file picker    │
│  (QuickPick/Tree) · per-file proposal cards · diff preview · checkpoints  │
│  · status bar (tokens/cost/stop)                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ L2  Thin shell (Extension Host, Node.js / TypeScript) — only "VS Code world" work │
│  activate/command registration · panel host · SecretStorage              │
│  WorkspaceEdit landing · DocumentSymbol queries · QuickDiff/Diff render   │
│  · checkpoint (git) execution · RPC server                               │
├──────────────────────────────────────────────────────────────────────────┤
│ L3  Python core (separate subprocess, JSON-RPC over stdio, no import vscode) │
│  AgentLoop · ModeRouter · PromptComposer · ContextEngine · ToolRegistry  │
│  PendingStore · ReviewPlanner · Guard · SessionStore · EventBus          │
├──────────────────────────────────────────────────────────────────────────┤
│ L4  Outbound adapter layer (Python)                                       │
│  LLMClient: OpenAI-compatible (httpx + SSE + tools)                      │
│  MCPClient: stdio + Streamable HTTP · SkillLoader · retrieval (ripgrep/tree-sitter) │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key constraint (v0.2 revision)**: there is **no** `vscode` module inside the Python process, so actions like "read file / write file / fetch symbols / land diffs / store keys" must be performed by the TS shell on its behalf; Python can only send **intents** over JSON-RPC (`fs.read`, `edit.apply`, `symbols.get`…). Conversely, the TS shell contains no business logic (it does not assemble prompts, parse model output, or manage budgets). This boundary is a hard one: crossing it inevitably creates long-term maintenance debt where "the same piece of logic is written twice, once on each side".

> Dependency direction: L1 → L2 → (RPC) → L3 → L4. L3 can degrade to a CLI without VS Code (using a local fs stand-in), which is one of the biggest wins of choosing a Python core: **agent logic can run and be tested independently**.

### 4.2 Full sequence of a Builder request

```
User: selects parseConfig() in a.ts, presses Ctrl+Alt+B, types "make it support .yaml config"
  │
  ├─(1) L2 collects "explicit context": selection text + file path + cursor position + 120 adjacent lines
  ├─(2) L2 collects "environment facts": workspace root / language / package.json summary / git branch / diagnostics
  ├─(3) L3 ModeRouter assembles the system prompt (builder.md overlay) + tool set (read + apply_*)
  ├─(4) L3 ContextEngine builds a "candidate context pack" (file inventory/keywords/symbols):
  │        · asks the shell over RPC for file.list / search.grep / symbols.outline
  │        · compresses it into the token budget, then uses it as the first-round messages
  ├─(5) LLMClient sends a streaming request (with tools declared) → model returns tool_calls: read_file / search_code
  ├─(6) ToolRegistry executes read-only tools (landing in the real workspace via RPC) → results fed back → loop (up to maxSteps)
  └─(7) model calls apply_patch
         │
         ├─ L3 ChangeApplier: pure Python computes the new text (if the patch doesn't apply, return an error to the model; disk untouched)
         ├─ L3 → L2 RPC `checkpoint.create`: take a shadow git snapshot **before** writing
         ├─ L3 Proposal: compute the corrected full text, stash it as a virtual file, broadcast metadata via `proposal.changed`
         ├─ user clicks "Accept" → shell fetches the body via `proposal.read` → `edit.apply` writes to disk → `proposal.decide(accept)`
         ├─ L2 renders: QuickDiff red/green lives on the real file; the panel lists file → function → change
         └─ "Accept all / Reject all" is also available; accepted changes can still be rolled back wholesale with `checkpoint.restore`
                └─ reject → no `edit.apply`; Restore → RPC `checkpoint.restore`
```

### 4.3 Module responsibilities

| Module | Layer | Responsibility | Does not do |
| --- | --- | --- | --- |
| `src/ui/*` | L1 | Render the session, Keep/Undo cards, diff navigation (the webview frontend is also TS) | Assemble prompts, parse model output |
| `src/shell/*` (TS) | L2 | Commands/menus/panel host, SecretStorage, WorkspaceEdit, QuickDiff, DocumentSymbol, RPC server | Contain business rules |
| `beecode/ipc.py` | L3 | JSON-RPC peer (stdio), method registration, timeouts, error mapping | Touch VS Code |
| `beecode/loop` | L3 | Drive the loop, state machine, cancellation, event broadcast | Care about rendering |
| `beecode/modes` | L3 | Mode definitions, capability matrix, mode switching | Read files directly |
| `beecode/prompts` | L3 | Prompt template assembly (base + overlay + memory + tools) | Contain vendor differences |
| `beecode/llm` | L3/L4 | OpenAI-compatible client, SSE parsing, retries, usage accounting | Choose models |
| `beecode/context` | L3 | Retrieval orchestration, budget allocation, compression (actual I/O goes over RPC) | Read the disk directly |
| `beecode/tools` | L3 | Tool registry, schema (pydantic), parameter validation, permission declarations | Write to disk directly |
| `beecode/apply` | L3 | Patch parsing (unified diff), new text computation, reverse patches | Perform the actual write |
| `beecode/proposals` | L3 | Proposal storage (virtual file bodies), accept/reject state machine | Call git directly, write to disk |
| `beecode/guard` | L3 | Steps/budget/repetition/no-progress detection, circuit breaking | Decide Keep/Undo |

---

### 4.4 Technical baseline for a VS Code extension (requirements + integration checklist)

This section answers "what exactly does building a VS Code extension require, and what does it have to integrate with".

#### 4.4.1 Hard requirements (skip them and it won't install / won't ship)

| Requirement | Details |
| --- | --- |
| **Directory + manifest** | The extension root must contain `package.json` (the **extension manifest**); the code entry point is given by `main` (Node/desktop) or `browser` (web extension) |
| **Required fields** | `name` (lowercase, no spaces, unique across the Marketplace), `version` (SemVer), `publisher`, `engines.vscode` (must not be `*`). The unique extension ID is `<publisher>.<name>` |
| **Lifecycle** | The entry module exports `activate(context)` and (optionally) `deactivate()`; `activate` runs exactly once, when some **activation event** occurs |
| **Activation events** | Since 1.74, commands declared in `contributes.commands` activate the extension **implicitly** when invoked, so `onCommand:...` is no longer needed; `onStartupFinished` slows startup and should be avoided when possible |
| **Runtime process** | Code runs in the **Extension Host** (a separate Node.js process) and cannot touch the DOM; all editor capabilities must go through the APIs of the `vscode` module, and custom UI is only possible with Webviews. **The Python core is a subprocess the extension itself spawns; it is not a host runtime** — it has no access to any `vscode` capability |
| **Packaging and publishing** | `npx @vscode/vsce package` produces a `.vsix`; publishing needs a Marketplace publisher + an Azure DevOps PAT, `README.md` becomes the store detail page body, and `icon` must be ≥ 128×128. If a sidecar binary ships with the extension, it must be published per platform with `--target win32-x64 / darwin-arm64 / linux-x64` |
| **Compliance** | Must not silently upload user code/data; telemetry, if any, must be declared and switchable off; extensions that support Workspace Trust must declare `capabilities.untrustedWorkspaces` |

The minimal runnable skeleton (the official Hello World layout): `package.json` + `src/extension.ts` + `tsconfig.json` + `.vscode/launch.json` (F5 debugging) + `.vscodeignore`.

#### 4.4.2 This project's "requirement → integration point" mapping

| Requirement | VS Code capability used (contribution point / API) |
| --- | --- |
| Sidebar Agent panel | `contributes.viewsContainers.activitybar` + `contributes.views` (`"type": "webview"`) + `WebviewViewProvider` + `webview.postMessage` / `onDidReceiveMessage` |
| Panel frontend assets | `webview.asWebviewUri()` + `localResourceRoots` + CSP `nonce` (no `unsafe-inline`) |
| Selected code → three modes | `contributes.menus["editor/context"]` + `contributes.keybindings` (`when: editorHasSelection`) + `window.activeTextEditor.selection` + `window.showTextDocument` |
| Workspace file list | `workspace.workspaceFolders` + `workspace.findFiles(include, exclude)` + `workspace.fs.*` + `createFileSystemWatcher` |
| Symbols / function boundaries | `commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)`, `vscode.executeWorkspaceSymbolProvider` |
| Diagnostics (Debugger mode) | `languages.getDiagnostics(uri)` + `languages.onDidChangeDiagnostics` |
| Red/green diff preview | `workspace.registerTextDocumentContentProvider(scheme, …)` + `commands.executeCommand('vscode.diff', left, right, title)` |
| Applying changes | `WorkspaceEdit` + `workspace.applyEdit()` (one call = one undo unit) |
| API key | `context.secrets` (`SecretStorage`: `get/store/delete/onDidChange`) |
| Settings | `contributes.configuration` + `workspace.getConfiguration('beeCode')` |
| Status bar (tokens/stop) | `window.createStatusBarItem()` |
| Logging and troubleshooting | `window.createOutputChannel('Bee Code')` + `… · core stderr` (two channels, everything passes through `redact()` before writing; diagnostics bundle in [§12.1.1](#1211-log-redaction-and-diagnostics-bundle-implemented)) |
| MCP tool interop (optional) | `contributes.mcpServerDefinitionProviders` + `lm.registerMcpServerDefinitionProvider()` |
| Native command / slash command integration (optional) | `contributes.commands` + `menus.commandPalette`; the chat side may additionally register a Chat Participant |

#### 4.4.3 Three technical routes for "should we use the official AI APIs"

| Route | What you get | Limitations | This project's choice |
| --- | --- | --- | --- |
| **Chat Participant API** (`contributes.chatParticipants` + `vscode.chat.createChatParticipant`) | Lives inside VS Code's native Chat: `@participant`, `/slash`, `#context`, native history and tool-approval UI | Output can only go through `ChatResponseStream` (mostly markdown, no custom React tree), and the flow is boxed in by `ChatRequestHandler`. **Technically you can `fetch` any endpoint inside the handler**; the limit is UX, not network | ❌ Not the main UI (we need custom Keep/Undo and preview UI) |
| **Language Model API** (`vscode.lm.selectChatModels`) | Call models already registered in the editor, with `LanguageModelChatMessage` + `registerTool` for native tool calls | Can only select **registered** models (typically provided by Copilot), constrained by quotas and administrator policy; cannot specify `base_url` directly | ❌ Cannot serve as the "any endpoint" channel |
| **Language Model Chat Provider** (`contributes.languageModelChatProviders` + `lm.registerLanguageModelChatProvider`) | **The official BYO-key path**: register your own endpoint as a model in the VS Code model picker; settings can use `"secret": true` so VS Code stores the key | You must implement bidirectional message/tool-call translation and token counting; the chat UI is still VS Code's | 🧪 **Bonus**: reuse the same client on the platform |
| **Own HTTP client + Webview panel** | Any OpenAI-compatible endpoint, any UI, full control over the loop and the review flow | Implement everything yourself (streaming, tool calls, retries, rendering, accessibility) | ✅ **v1 main line** |

> 🧪 Bonus (not in conflict): later implement `contributes.languageModelChatProviders` to **register the user's own endpoint as a VS Code model**, so "my DeepSeek" is selectable in native Chat too. Two caveats: first, you must implement the streaming conversion for `provideLanguageModelChatResponse` yourself; second, Copilot Business/Enterprise administrators can disable BYO keys by policy, which is expected.

#### 4.4.4 Webview security red lines

- All assets go through `asWebviewUri`, with `localResourceRoots` restricted to the `dist/webview` directory.
- Strict CSP: `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`.
- Validate both directions of the message channel: whitelist `type` inside `onDidReceiveMessage`, and **do not trust** paths sent from the frontend (the frontend can be injected).
- `retainContextWhenHidden` is off by default (it keeps a hidden webview eating memory); use "state serialization + restore" instead.

---

### 4.5 Shell ↔ core IPC contract (JSON-RPC 2.0 over stdio)

Choosing `stdio` over TCP/HTTP is a practical decision: **no port, no authentication, and the subprocess exits when the host exits** — VS Code's own LSP and MCP work the same way. The framing is **NDJSON** (one JSON per line): `JSON.stringify` never emits a bare newline, so splitting on `\n` is safe and simpler than LSP's `Content-Length` header.

```
TS shell (server side of stdin/stdout)  ⇄  Python core (subprocess)
      request/response (with id)  +  notification (no id)
```

#### 4.5.1 Core → shell (Python asks the editor to do work)

| Method | Parameters | Returns | Notes |
| --- | --- | --- | --- |
| `fs.read` | `path, startLine?, endLine?` | `{ text, version?, totalLines?, startLine, endLine, truncated }` | Prefers the editor's **unsaved** content |
| `fs.list` | `glob, exclude?, maxResults?` | `{ paths[], truncated }` | Over-fetch, then filter (so ignored files don't eat the quota); the shell merges `files.exclude` + `.gitignore` |
| `search.grep` | `query, regex?, glob?, contextLines?, maxResults?, filesOnly?` | `{ hits[], files?, truncated }` | Per-file regex inside the shell; `filesOnly` returns only files + counts (saves tokens in the recall phase) |
| `symbols.outline` | `path` | `{ symbols[], source }`; each symbol carries `range` (including comments) and `selection` (exact identifier position) | `executeDocumentSymbolProvider` |
| `symbols.search` | `query, maxResults?` | `{ symbols[], source: lsp\\|fallback\\|none, truncated }` | `executeWorkspaceSymbolProvider` (results outside the workspace/dependencies are filtered); when there is no provider, falls back to "crude name-based file filter + outline" |
| `symbols.references` | `path, line, column?, maxResults?` | `{ locations[], truncated }` | `executeReferenceProvider`; **line must use `selection.startLine`** (the start line of `range` may land in a comment) |
| `diagnostics.get` | `path?` / `minSeverity?` / `maxItems?` (default 200, max 2000) / `includeIgnored?` | `{ items[], total, truncated }`; each item carries `code` (e.g. `TS2322`) and 1-based line/column | `languages.getDiagnostics`, sorted by severity, with `node_modules`/`.git`/`.gitignore` filtered out by default |
| `edit.apply` | `path` / `newText` / `op?` (`write`\|`delete`) / `expectedVersion?` / `reason?` | `{ applied, version?, conflict?, message? }` | **The only write channel**: a single `WorkspaceEdit` (new files go through `createFile` + `insert`; line endings follow the target file) |
| `checkpoint.create` | `label?` / `paths?` | `{ id, files, skipped?, reason? }` | Shadow git snapshot (`paths` selects the lightweight mode) |
| `checkpoint.restore` | `id` | `{ restored[] }` | Restores files only; task/session state is recomposed by the core |
| `diff.open` | `path, baseText` | `{}` | Opens a `vscode.diff` comparison |
| `confirm.ask` | `question, detail?, options[], rememberKey?` | `{ choice }` | The write guardrail asks the human through this; `detail` is shown below the options |
| `secrets.get` | `key` | `{ value }` | Fetched once at session start, never logged |

#### 4.5.2 Shell → core (user actions)

| Method | Parameters | Notes |
| --- | --- | --- |
| `initialize` | `protocolVersion, workspaceRoots[], modelConfig, hasKey` | Handshake; a version mismatch fails immediately with a readable reason |
| `chat.send` | `sessionId, mode, text, attachments[]` | Starts a turn (`attachments` = selection/file references) |
| `proposal.read` | `id` | Fetches the proposal body (virtual file content) |
| `proposal.decide` | `id, decision` | Tells the core **after** the shell has written or discarded the change |
| `session.abort` | `sessionId` | Cancels (also cancels every in-flight RPC) |
| `model.reload` | `modelConfig` | The user changed the configuration |

#### 4.5.3 Notifications (no id, one-way)

- `ui.delta` `{ sessionId, text }` — streaming text, pushed chunk by chunk to the panel.
- `ui.tool` `{ sessionId, name, args, status }` — a tool starts/finishes.
- `ui.usage` `{ inputTokens, outputTokens, costUsd }`.
- `proposal.changed` `{ added[], updated[], removed[] }` — metadata only; the shell refreshes cards from it and fetches bodies on demand via `proposal.read`.
- `log` `{ level, msg, fields }` — the shell writes it to the OutputChannel (after redaction).

#### 4.5.4 Five engineering conventions

1. **Cancellation must be able to penetrate**: `$/cancelRequest` style (carrying the cancelled `id`); on receipt the core aborts HTTP requests and tools with an `AbortSignal`, and when the shell receives `session.abort` it also cancels its own in-flight RPCs.
2. **The key travels once, in the handshake**: `apiKey` is passed via the **subprocess stdin** of `initialize`, **never in argv** (visible to `ps` across the machine) and never in environment variables (readable by the same user, easily captured into logs by `env`). The core holds it in memory only.
3. **Path policy belongs to the shell**: paths coming from the core may be fabricated by the model, so the shell must independently validate "inside the workspace? / hit the deny list?" (defense in depth: both sides validate).
   - **Cancellation must reach in-flight promises**: besides notifying the core, `abort()` must also reject the in-flight `chat.send` — otherwise the shell hangs until a 30-minute timeout while `busy` has already been reset, letting the user send another turn → two agent loops at once.
   - **The write pipe must handle backpressure**: when `stdin.write()` returns false, wait for `drain`, otherwise large payloads pile up in memory.
   - **Map error codes in one place only** (`protocol.rpcCodeFor`); writing them twice is guaranteed to drift.
4. **The protocol must be versioned**: `protocolVersion` is an integer; when shell and core do not match, **refuse to start** and suggest "please reinstall the extension" rather than running with half-understood semantics.
5. **The contract has a single source of truth**: `protocol/contract.json` lists every method, required/optional parameters, and return fields. Both sides run a reconciliation at startup:

   | Side | What is checked | What happens on failure |
   | --- | --- | --- |
   | Shell (`src/contract.ts`) | Methods registered at runtime ↔ contract declarations; contract `version` ↔ `PROTOCOL_VERSION` | An `error` log + a warning naming "registered but not declared / declared but not registered" |
   | Core (`beecode/contract.py`) | Before every RPC: the method exists, required params are present, no misspelled extra params | Raises `ContractError`, blocked **before** it is sent |

   Why it is needed: TS interfaces disappear after compilation, and Python cannot see TypeScript either, so method/parameter names on both sides can only be kept in sync by hand. This JSON file turns "by hand" into "reconciled automatically within 100 ms of startup".

   The `id` type is part of this convention too: JSON-RPC allows `number | string`; requests sent by the shell use auto-incrementing `number`, but a `string` id received from the peer must be echoed unchanged (`JsonRpcId`).

---

## 5. Model access layer (OpenAI-compatible)

### 5.1 Why unify on the OpenAI format

- De facto standard: `POST {base_url}/chat/completions`, `messages[]`, `tools[]`/`tool_calls`, and SSE streaming deltas — almost every vendor, domestic or foreign, ships a compatibility layer (DeepSeek, Qwen/DashScope compatible-mode, Kimi, GLM, OpenRouter, Ollama, vLLM, LM Studio, one-api/new-api…).
- Maintaining one client = maintaining one tool-call parser, one streaming state machine, and one usage accountant.
- "Bring your own endpoint" is the highest-priority requirement: if the user has a compatible endpoint that works with `curl`, the extension must work with it.

> Relationship to the official VS Code AI APIs: `vscode.lm.selectChatModels` (Language Model API) **can only select models already registered in the editor** and cannot directly specify an arbitrary `base_url` with the user's own key, so it cannot serve as the BYO channel. The genuine "officially supported bring-your-own-endpoint" entry is the **Language Model Chat Provider API** (`contributes.languageModelChatProviders`), but it requires you to implement only the "provider side" (wrapping the endpoint as a model); the chat UI and the loop still belong to VS Code. For v1 this project builds its own client in order to fully control the Agent Loop, the review flow, and the preview; 🧪 in v2 the same client can be wrapped as a Chat Provider to give back to the platform, see [§4.4.3](#443-three-technical-routes-for-should-we-use-the-official-ai-apis).

### 5.2 User configuration

Settings live in `settings.json` (**these are the only parts that may enter git — there are no keys**):

```jsonc
{
  "beeCode.model": {
    "baseUrl": "https://api.deepseek.com/v1", // without /chat/completions
    "model": "deepseek-chat",
    "apiKeyId": "beeCode.apiKey.default",   // the name of the SecretStorage key, not the key itself
    "temperature": 0.2,
    "maxOutputTokens": 8192,
    "stream": true,
    "supportsTools": true,                    // native function calling available
    "supportsVision": false
  },
  "beeCode.agent": {
    "maxSteps": 30,
    "maxTokensPerTask": 400000,
    "toolTimeoutMs": 30000,
    "longToolTimeoutMs": 600000,
    "defaultMode": "chat"
  },
  "beeCode.review": {
    "granularity": "function",                // function | change | file
    "autoAcceptDelayMs": 0,                  // 0 = disable the "auto accept" countdown
    "gateGlobs": ["**/.env*", "**/*.pem", "**/.github/workflows/**"],
    "gateBatch": { "files": 5, "lines": 300 } // confirm before writing if exceeded
  }
}
```

First use goes through a "setup wizard" (the `beeCode.model.configure` command):

1. Enter `base_url` (offering a dropdown of common providers: DeepSeek / OpenAI / Qwen / Kimi / GLM / OpenRouter / local Ollama…).
2. Enter `model` (🔬 after input, call `GET {base_url}/models` to fetch candidates; if that fails, allow manual entry).
3. Enter `api_key` (`inputBox({ password: true })`); it is stored immediately in `context.secrets.store(...)` and **never echoed back**.
4. Send a minimal `ping` request (1 token) to verify connectivity; on failure, show the HTTP status and a readable reason.

### 5.3 Key storage

| Location | May it hold the key? | Notes |
| --- | --- | --- |
| `settings.json` (user/workspace) | ❌ | Plaintext, synced, committed to git |
| `context.secrets` (SecretStorage) | ✅ **the only place** | Encrypted underneath by the OS credential store (macOS Keychain / Windows DPAPI / Linux libsecret) |
| `globalState` / `workspaceState` | ❌ | Plaintext JSON |
| Logs / telemetry / crash reports | ❌ | Everything passes through `redact()` (`sk-*` and vendor prefixes such as `gsk_`/`ghp_`/`AIza`, `Bearer *`, key/signature in URL queries, JSON config fields); the core's stderr is filtered the same way |
| Memory (while requesting) | ✅ | Lives only for the few milliseconds of a request and is released when the `AbortSignal` ends |

**Resolution order (since v0.5)**: `SecretStorage` → environment variable `BEE_CODE_API_KEY` → if neither exists, report "not configured".

The environment variable is only a **fallback**, never a replacement for SecretStorage: it is visible to the entire process (any child process or debugger can read it), so it always ranks after explicit configuration. It exists for cases like "CI / don't want the key in a credential store / temporarily switch keys".

**Settings scope is also a security boundary**:

| Setting | Scope | Reason |
| --- | --- | --- |
| `beeCode.model.baseUrl` | **machine** | If a workspace could override it, a malicious repository's `.vscode/settings.json` could send questions, code snippets, and keys to an attacker's endpoint (and the user would see no prompt inside a trusted workspace) |
| `beeCode.model.apiKeyId` | **machine** | A workspace has no reason to change the `SecretStorage` key name |
| `beeCode.model.model` | window | Changing the model name only affects answer quality, not where data goes |

Key properties of `SecretStorage` (which decide why it is the one correct place): **encrypted at rest**, **excluded from Settings Sync**, and on desktop backed by Electron `safeStorage` (i.e., the OS credential store). Conversely, `settings.json` written through `contributes.configuration` is **plaintext, synced by Settings Sync to other machines, and committed by dotfiles repos** — the most common source of "key leaks".

Additional industry practices (all adopted here, see [§12](#12-security-and-privacy)):

- **Child-process environment scrubbing**: when invoking MCP servers / commands, strip environment variables like `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*KEY*`, `*AUTH*` so keys are not handed to third-party processes by accident (the Claude Code approach).
- **URL and error-message redaction**: replace credentials in URLs with `REDACTED` in logs and error messages, and never print the fully expanded URL.
- **Explicit credential-type choice**: let users choose `keyring` / `file` / `ephemeral` as Codex does, rather than secretly falling back to a plaintext file; this project offers only `SecretStorage`, the equivalent of `keyring`.
- **Counter-example**: writing keys into `config.yaml` / `.env` / YAML config is common for CLI tools (Continue and Aider both do it) but unacceptable for a GUI product — users never see that file, so they will never protect it.

### 5.4 Request and response conventions

```python
# beecode/llm/types.py
class ChatRequest(BaseModel):
    model: str                              # from settings
    messages: list[ChatMessage]             # system | user | assistant | tool
    tools: list[ToolSpec] | None = None     # JSON Schema
    tool_choice: Literal["auto", "none"] | dict | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    stream: bool = True

class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[ContentPart] | None = None
    tool_calls: list[ToolCall] | None = None    # assistant side
    tool_call_id: str | None = None             # tool side
    name: str | None = None
```

- **Streaming**: parse SSE `data: {...}` with `httpx`'s `client.stream()`, accumulate `delta.tool_calls[i].function.arguments` fragments, and merge by `index` (the most common source of vendor differences: some omit `index`, some deliver `arguments` in one go).
- **First packet / timeouts**: `httpx.Timeout(connect=15, read=90)`; wrap an idle timeout of 60s with `asyncio.wait_for`; cancel via `asyncio.Task.cancel()` (corresponding to the shell's `session.abort`).
- **Usage**: read `usage` when present; otherwise estimate with `tiktoken` and mark the value as an estimate.

### 5.5 Compatibility matrix and degradation (🔬 PoC per vendor)

| Family | Endpoints | Known differences | Handling |
| --- | --- | --- | --- |
| OpenAI official | `/v1` | Newer models use `max_completion_tokens`; `tool_choice` is fully supported | Map fields by model name |
| DeepSeek | `/v1` | Has a separate `reasoning_content` field; some models do not support a forced `tool_choice` | Drop/fold reasoning; degrade `tool_choice` to `auto` |
| Qwen / DashScope | `/compatible-mode/v1` | On some models, multimodality and tools cannot be enabled together | Disable vision for the session |
| Moonshot / Kimi | `/v1` | Long context; different `max_tokens` ceilings | Read `/models` or use preset profiles |
| Zhipu GLM | `/api/paas/v4` | Slight differences in field naming | Profile override |
| Ollama / vLLM / LM Studio | `/v1` (local) | May not support tools or `stream_options` | When tools are unsupported, fall back to **JSON mode** (below) |
| Aggregator gateways (one-api/new-api/OpenRouter) | `/v1` | Upstream differences are absorbed by the gateway, but error codes are non-standard | Normalize errors uniformly |

**Tool-call degradation** (when `supportsTools: false`): the prompt states a strict JSON output protocol asking the model to emit exactly one `json` code block shaped like `{"tool":"read_file","args":{...}}`; the core parses it into a "pseudo tool_call" and then runs the same execution and approval pipeline as usual. If parsing fails, it retries with a correction hint quoting the previous format error. This way even the most basic local model can run Builder.

### 5.6 Vision capability: don't guess from the model name (implemented)

There are three sources for deciding "can this model receive images", ordered by reliability:

| Source | Reliability | Notes |
| --- | --- | --- |
| `beeCode.model.supportsVision: on/off` | 100% | Only the user knows what they are connected to; used as an **override**, never as a guess |
| Server feedback (cached) | High | An image request succeeded → True; explicitly rejected → False; recorded per `baseUrl + model` |
| Not recorded yet | — | **Optimistic**: send the image first |

Self-healing flow:

```
Model returns 400/415/422 with image / vision / modality / image_url … in the error
        │
        ├─ Strip image_url from the messages and replace it with "[image omitted: the current model does not accept image input]"
        ├─ Cache False (later rounds omit images entirely)
        ├─ ui.tool(guard, error) tells the user + one warn log line
        └─ Retry once (on success, the turn continues)
```

Why not enumerate model names any more: lists always lag behind new models and cannot handle private deployments that rename models (`--served-model-name`);
and the cost of "try once" is a single request round-trip, after which the result is remembered permanently.

Boundary: only **explicit image rejections** are recognized (`400/415/422` + related wording); 400s caused by bad parameters or insufficient quota are never misread as "no vision".
The cache lives only inside the process (the core re-learns after a restart) so that one transient failure is not recorded as a permanent conclusion.

### 5.8 Reasoning content: view it, never send it back (implemented)

Some models return a separate chain of thought in SSE, with different field names:

| Source | Field |
| --- | --- |
| DeepSeek-R1 | `delta.reasoning_content` |
| OpenRouter | `delta.reasoning` |
| Some gateways | `delta.thinking` (string or `{text}`) |

Handling strategy:

| Aspect | Behavior |
| --- | --- |
| Capture | Recognize the three fields above in order and normalize them into `ChatDelta.reasoning` |
| UI | Broadcast `ui.reasoning`; the panel renders a collapsed "thinking process" block reused for the turn, auto-collapsing when the answer starts |
| Context | **Never written into messages** and excluded from summaries; but it is persisted per assistant message in the session JSONL `reasoning` field for later review |
| Replay | By default **not replayed** (`model.reasoningReplay=auto`); when the server errors and asks for `reasoning_content`, add it back automatically and retry once |
| Forced policy | `always` always replays; `never` never replays (compatibility with models that explicitly forbid replay) |

Review: reasoning is persisted **segmented per model call** (`[{round, text}]`) alongside the assistant message,
so it **survives the end of the turn, session switches, and window reloads**,
and appears in the panel as a collapsed "Thinking · call N" block by default; it never participates in model context, so it cannot "resurrect" into the prompt across turns.
Replay only happens on assistant tool-call messages within the same turn.

### 5.7 Error handling

| Situation | Strategy |
| --- | --- |
| 401/403 | No retry; report "invalid key / no permission" and offer a "reconfigure" button |
| 429 | Exponential backoff + `Retry-After`, at most 3 attempts; the UI shows a countdown |
| 5xx / network interruption | Backoff retry twice; if a stream breaks, keep the text produced so far and allow "continue generating" |
| Context overflow (400 context_length_exceeded) | Trigger compression ([§8.4](#84-compression-and-memory)) and retry once |
| Invalid response JSON (broken tool_calls) | Append a "correction hint" and retry once; if it still fails, hand the raw text to the user with an error |

---

## 6. Three-mode design

### 6.1 Capability matrix

| Dimension | 💬 Chat | 🏗 Builder | 🐞 Debugger |
| --- | --- | --- | --- |
| Goal | Explain, answer questions, understand code, walk through design | Generate/refactor/complete code and produce changes | Locate defects, propose fixes, include regression verification |
| Tool set | Read-only (`list_files` / `read_file` / `search_code` / `file_outline` / `get_diagnostics`) | Read-only + `apply_patch` / `create_file` / `delete_file` (direct write + pending review) | Read-only + `apply_*` + 🧪`run_command`/`run_test` |
| May it modify files? | ❌ Hard no (write tools are simply absent from the tool list) | ✅ Writes directly; every write is marked pending review | ✅ Writes directly; every write is marked pending review |
| Output contract | Natural language + `file:line` references + optional Mermaid diagram | Change proposal + change summary + impact analysis | Root cause → evidence → fix proposal → verification method |
| Default temperature | 0.3 | 0.5 | 0.2 (for determinism) |
| Typical trigger | Select code `Ctrl+Alt+K`, `@chat` | Select code `Ctrl+Alt+B`, `/build` | Select code `Ctrl+Alt+D`, diagnostics context menu "fix with Debugger" |
| Ending condition | An answer is given (tools may go unused) | At least one pending change, or an explicit "cannot complete" | Pending changes + verification conclusion |

> Engineering note on mode isolation: Chat mode must **not** declare write tools in `tools[]` and then forbid them via the prompt — prompts can be bypassed; the correct approach is "the model simply cannot see the tool". This is least privilege applied directly to agents.

### 6.2 Prompt structure

```
system =
  ┌ BASE (shared by all three modes) ──────────────────
  │ Role definition / available tools and usage discipline / output format
  │ Safety red lines (no keys, no invented APIs, say "don't know" when unsure)
  │ Environment facts (workspace name, root path, language, git branch, time)
  │ Project rules (AGENTS.md / .beecode/rules/*.md injected)
  ├ MODE OVERLAY (mutually exclusive, from modes/*.md) ─
  │ chat.md | builder.md | debugger.md
  └ Runtime additions ─────────────────────────────────
  │ Selected context for this turn / list of files already read / token budget hints
```

Why "BASE + OVERLAY" instead of three complete prompts: the shared part is maintained once, avoiding drift between three prompts; mode differences stay concentrated in a 30–60 line overlay, so a reviewer can see the differences at a glance.

### 6.3 Chat mode prompt (skeleton)

```markdown
# Role
You are the team's senior code explainer. Your job is to make the asker **truly understand**
this code in the shortest possible time, not to hand them a rewritten version.

# Rules
- Read-only: you have no file-writing tools, and you must not output whole-file code beyond "change line 12 to …".
- Every conclusion needs a source: `path:line`, quoting the code you actually read (≤5 lines).
- Give a one-sentence conclusion first, then the expanded explanation, then the pitfalls to watch out for.
- When a call chain is involved, describe A → B → C as an ordered list and name the file backing each step.
- Explicitly mark anything unverified as "unverified"; never invent functions or settings that do not exist.

# Output
## Conclusion
## Section-by-section explanation
## Dependencies and call chain
## Risks and recommendations
```

### 6.4 Builder mode prompt (skeleton)

```markdown
# Role
You are the implementer. You produce **committable changes** that are minimal, readable, and consistent
with the existing style.

# Workflow (strictly follow)
1. Explore first: use list_files / search_code / read_file to find every place that needs to change; never guess.
2. Restate the task: describe the task and its boundaries in ≤3 lines (including what you will not do).
3. Then write: produce changes with apply_patch, one file at a time, using a standard unified diff (the result is
   shown to the user as a proposal for preview).
   (The user accepts / rejects each file; nothing is written until accepted — you do not need to ask for approval again.)
4. Self-check: verify imports, types, naming, error handling, and edge cases after the change.

# Rules
- Do not touch code unrelated to this task; do not "optimize" formatting along the way.
- Do not remove existing error handling, logging, or comments unless the task explicitly requires it.
- New dependencies must be listed explicitly with a justification.
- If you cannot complete the task, explain where you are stuck and what information is missing; do not deliver half-finished work.

# Output
## Change summary (file → function → one sentence)
## Impact (callers / tests / configuration)
## Open questions (if any)
```

### 6.5 Debugger mode prompt (skeleton)

```markdown
# Role
You are a defect-localization expert. Your first product is a **root-cause hypothesis and evidence chain**;
the fix patch is only the second.

# Workflow
1. Reproduction hypothesis: derive "symptom → trigger path → suspect hypothesis" from the stack trace / diagnostics / user description.
2. Evidence gathering: read the relevant function bodies and call sites, plus tests and configuration when needed; label each hypothesis with evidence for/against it (`path:line`).
3. Converge: eliminate hypotheses and pin down the root cause; when you cannot, output "what else is needed" instead of guessing.
4. Fix: produce a minimal apply_patch, and explain "why this removes the root cause, not just the symptom".
5. Regression: describe which test cases the fix needs (optionally verify with run_test).

# Rules
- Fake fixes like wrapping the error in try/catch are forbidden unless the user explicitly asks for tolerance.
- Distinguish the "root cause" from the "triggering condition"; both must be stated.
- Every fix must state its side effects and how to roll it back.
- **Empty diagnostics ≠ no problems**: `diagnostics.get` only returns files "already analyzed by the language service";
  right after opening a window only a few files may have values. When diagnostics are empty, say "no diagnostics available yet;
  the project may not be analyzed", rather than asserting "there are no compile errors".

# Output
## Root cause
## Evidence chain (hypothesis → evidence → conclusion)
## Fix and patch
## Verification and regression recommendations
```

### 6.6 Mode switching

- A three-way switcher at the top of the UI (Chat / Builder / Debugger); the current mode determines the "input placeholder" and the "available toolbar buttons".
- Modes can be switched within one session: **history is preserved**, but a system-level "mode change" notice is inserted on switch and the tool set is replaced wholesale (so the model cannot hallucinate with tools remembered from the previous mode).
- Keyboard shortcuts / the context menu jump "into a mode with the selection attached"; see [§9](#9-selection-shortcut-entry-points).

---

## 7. Agent core and loop

### 7.1 Loop state machine (implemented)

```

<!-- END -->
