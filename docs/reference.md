[English](reference.en.md) | 中文

# Bee Code 参考资料

> 调研时查阅的官方文档、协议规范与工业实践来源。
## 20. 参考资料

### 20.1 VS Code 扩展开发

- Extension Anatomy（扩展三个核心概念：激活事件 / 贡献点 / API）— <https://code.visualstudio.com/api/get-started/extension-anatomy>
- Extension Manifest（`package.json` 字段全表，`main` / `browser` / `engines` / `capabilities`）— <https://code.visualstudio.com/api/references/extension-manifest>
- Contribution Points — <https://code.visualstudio.com/api/references/contribution-points>
- Activation Events（1.74 起的隐式激活说明）— <https://code.visualstudio.com/api/references/activation-events>
- Extension Host（扩展宿主进程模型：只有 Node.js / Browser 两种运行时，没有 Python）— <https://code.visualstudio.com/api/advanced-topics/extension-host>
- 「能不能用 Python 写 VS Code 扩展」的社区定论（只能薄壳 + 子进程）— <https://stackoverflow.com/questions/62848396/can-i-create-vs-code-extensions-in-python-c>
- pygls（Python 写 **LSP 语言服务器**，不是扩展框架；容易混淆）— <https://github.com/openlawlibrary/pygls>
- Webview API 指南（CSP / nonce / `asWebviewUri` / 消息传递）— <https://code.visualstudio.com/api/extension-guides/webview>
- Chat Participant API — <https://code.visualstudio.com/api/extension-guides/ai/chat>
- Language Model API（`vscode.lm`）— <https://code.visualstudio.com/api/extension-guides/ai/language-model>
- Language Model Tool API — <https://code.visualstudio.com/api/extension-guides/ai/tools>
- AI Extensibility 总览（四种扩展 AI 的路线对比）— <https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview>
- MCP Developer Guide（VS Code 的 MCP 支持面：tools / prompts / resources / elicitation / sampling / OAuth / roots）— <https://code.visualstudio.com/api/extension-guides/ai/mcp>
- Workspace Trust — <https://code.visualstudio.com/api/extension-guides/workspace-trust>
- Bundling & Publishing（vsce / `vscode:prepublish` / PAT）— <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>

### 20.2 协议与模型

- Model Context Protocol 规范（2025-06-18，含 transports / authorization）— <https://modelcontextprotocol.io/specification/2025-06-18>
- MCP TypeScript SDK — <https://github.com/modelcontextprotocol/typescript-sdk>
- OpenAI Chat Completions（`tools` / `tool_calls` / 流式）— <https://platform.openai.com/docs/api-reference/chat>
- Language Server Protocol（`textDocument/documentSymbol`）— <https://microsoft.github.io/language-server-protocol/>
- tree-sitter（增量解析，用于符号与 repo map）— <https://tree-sitter.github.io/tree-sitter/>

### 20.3 参考项目与工业实践

| 项目 | 为什么值得看 |
| --- | --- |
| Cline | VS Code 内最成熟的「Agent + 逐次编辑审批 + checkpoint」实现，宿主与视图分离 |
| Continue.dev | core / extension / GUI 三层解耦，`@` 上下文提供者、自定义模型（含本地） |
| Aider | repo map（tree-sitter + 图排序）、多种 edit format、自动 git commit 与测试回路 |
| Claude Code | agentic search、权限模式、Skills 渐进披露、`/compact` 压缩、MCP 双向 |
| OpenAI Codex CLI | 平台级沙箱（seatbelt / Landlock+seccomp）与审批模式的最小可用组合 |
| OpenHands | 容器化 runtime + 事件流架构，研究级 agent 的工程样板 |
| GitHub Copilot（VS Code 内） | 原生 agent mode 的工具审批、working set 的 Keep / Undo 交互范式 |

（具体机制对照见 [§14 工业界参考](./architecture.md#14-工业界参考)。）

### 20.4 各项目文档（调研时实际查阅）

- Claude Code：agent loop / permissions / sandboxing / context window / skills / memory / checkpointing — <https://code.claude.com/docs/en/agent-sdk/agent-loop>、<https://code.claude.com/docs/en/sandboxing>、<https://code.claude.com/docs/en/context-window>、<https://code.claude.com/docs/en/skills>、<https://code.claude.com/docs/en/checkpointing>
- Cline：tools / auto-approve / checkpoints / skills — <https://docs.cline.bot/tools-reference/all-cline-tools>、<https://docs.cline.bot/features/auto-approve>、<https://docs.cline.bot/core-workflows/checkpoints>、<https://docs.cline.bot/customization/skills>
- Continue：rules / edit diff 行为 / `@Codebase` 弃用说明 — <https://docs.continue.dev/reference>、<https://docs.continue.dev/ide-extensions/edit/how-it-works>、<https://docs.continue.dev/reference/deprecated-codebase>
- Aider：repo map / 配置项（`--map-tokens`、`--max-chat-history-tokens`）— <https://aider.chat/docs/repomap.html>、<https://aider.chat/docs/config/options.html>
- OpenHands：架构总览 / 安全 / 上下文压缩 — <https://docs.openhands.dev/sdk/arch/overview>、<https://docs.openhands.dev/sdk/guides/security>
- Codex：配置说明（`sandbox_mode` / `approval_policy`）— <https://github.com/openai/codex>
- VS Code 官方「审阅 AI 改动」行为（`Keep`/`Undo`、pending 语义）— <https://code.visualstudio.com/docs/agents/run/review-code-edits>
- JetBrains AI Assistant 的逐改动 Accept/Revert gutter — <https://www.jetbrains.com/help/ai-assistant/find-and-fix-problems-with-ai.html>
- Google《Software Engineering at Google》第 19 章 Critique（intraline diff、move detection、reviewed 标记）— <https://abseil.io/resources/swe-book/html/ch19.html>

### 20.5 diff / patch 的格式与算法

- GNU diffutils 统一 diff 格式（`-U3` 上下文约定）— <https://www.gnu.org/software/diffutils/manual/html_node/Unified-Format.html>
- `git diff`（`myers`/`minimal`/`patience`/`histogram`、`--indent-heuristic`）— <https://git-scm.com/docs/git-diff>
- `git apply`（`--recount`、`--unidiff-zero`、`--check`、`--3way`、`-R`）— <https://git-scm.com/docs/git-apply>
- `git worktree`（多工作树、`--detach`、`--no-checkout`）— <https://git-scm.com/docs/git-worktree>
- jsdiff（`structuredPatch` / `applyPatch` / `reversePatch`，hunk 级接受的数据模型）— <https://github.com/kpdecker/jsdiff>
- diff-match-patch（字符级高亮；不宜作为接受/拒绝的记账层）— <https://github.com/google/diff-match-patch>
- patch-package（「整文件原子应用 + `--partial` 显式降级」的策略范本）— <https://github.com/ds300/patch-package>
- Monaco / VS Code diff 编辑器选项（`renderSideBySide`、`ignoreTrimWhitespace` 默认 true、`diffAlgorithm`、`maxComputationTime`）— <https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.IDiffEditorBaseOptions.html>
- difftastic（结构化 diff 的可视化；**明确不生成可应用 patch**）— <https://github.com/Wilfred/difftastic>
- Mergiraf（语法感知合并，可用于「过期提案自动 rebase」）— <https://mergiraf.org>
- VS Code SCM QuickDiff（`quickDiffProvider` + `scm/change/title` 菜单的 `LineChange[]`）— <https://code.visualstudio.com/api/extension-guides/scm-provider#quick-diff>
- `vscode.changes` 命令（公开的多文件 diff 入口）— <https://code.visualstudio.com/api/references/commands>
