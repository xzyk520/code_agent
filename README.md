# Bee Code for VS Code

> 一个「自带模型」（BYO-Model）的通用代码智能体 VS Code 扩展：**Chat / Builder / Debugger** 三模式协作，
> 统一走 **OpenAI 兼容协议**；所有改动**直接写入工作区**并立即标记为「待审」，以 **红绿 diff + 逐函数 Keep/Undo** 收尾，随时可整轮回滚。

![status](https://img.shields.io/badge/status-design--phase-orange)
![vscode](https://img.shields.io/badge/vscode-%5E1.104-blue)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 目录

- [0. 文档说明](#0-文档说明)
- [1. 项目定位](#1-项目定位)
- [2. 设计原则](#2-设计原则)
- [3. 术语表](#3-术语表)
- [4. 总体架构](#4-总体架构)
  - [4.4 VS Code 扩展的技术基线（要求 + 对接清单）](#44-vs-code-扩展的技术基线要求--对接清单)
  - [4.5 壳 ↔ 内核的 IPC 契约](#45-壳--内核的-ipc-契约json-rpc-20-over-stdio)
- [5. 模型接入层（OpenAI 兼容）](#5-模型接入层openai-兼容)
- [6. 三模式设计](#6-三模式设计)
- [7. Agent 内核与循环](#7-agent-内核与循环)
- [8. 工作区感知与上下文工程](#8-工作区感知与上下文工程)
- [9. 选区快捷入口](#9-选区快捷入口)
- [10. 改动落地：写入 + 待审](#10-改动落地写入--待审write-then-review)
- [11. 预览、逐函数 Keep/Undo 与回滚](#11-预览逐函数-keepundo-与回滚)
- [12. 安全与隐私](#12-安全与隐私)
- [13. Skill 与 MCP 集成](#13-skill-与-mcp-集成)
- [14. 工业界参考](#14-工业界参考)
- [15. 目录结构](#15-目录结构)
- [16. 路线图](#16-路线图)
- [17. 开发与构建](#17-开发与构建)
- [18. Git 与 GitHub 工作流](#18-git-与-github-工作流)
- [19. 许可与致谢](#19-许可与致谢)
- [20. 参考资料](#20-参考资料)

---

## 0. 文档说明

- 本文档描述 **v0.0.x 设计阶段** 的总体架构，会随实现持续修订；接口以代码为准，本文以「为什么这样设计」为准。
- 标记约定：🧭 已定方案 ｜ 🔬 需在实现期验证（PoC） ｜ 🧪 实验性/可选。
- 本文档同时是一份**调研结论文档**：每个关键设计点都尽量给出对应工业界做法与出处（见 [§14](#14-工业界参考) 与 [§20](#20-参考资料)）。
- 项目定名 **Bee Code**：仓库名 `bee-code`，扩展 ID `<publisher>.bee-code`，显示名 `Bee Code`，命令前缀 `beeCode.`，配置项命名空间 `beeCode.*`，项目内数据目录 `.beecode/`，虚拟文档 scheme `beecode-base:` / `beecode-proposed:`。
- 修订：**v0.1 起，改动落地范式从「Overlay 先审后写」改为工业主流的「写入 + 待审（Keep/Undo）」**，理由见 [§14.10](#1410-为什么最终改用主流范式先写后审)，方案见 [§10](#10-改动落地写入--待审write-then-review)。
- 技术栈（v0.2 定）：**Python 内核 + TypeScript 薄壳**。VS Code 扩展 API 只有 TS/JS（Extension Host 是 Node.js），Python 无法作为扩展语言；因此把 agent 逻辑（循环/检索/提示词/补丁/协议）全部放进 Python 子进程，TS 壳只做编辑器集成。契约见 [§4.5](#45-壳--内核的-ipc-契约json-rpc-20-over-stdio)，分发方案见 [§17.1](#171-python-运行时分发这是-a-方案最大的成本必须早定)。
- 许可证：**MIT**（见 [LICENSE](./LICENSE)）。

---

## 1. 项目定位

### 1.1 一句话

把「一个能读懂你整个工程、能解释、能写、能修的 AI 结对程序员」装进 VS Code，并且**模型完全由用户自带**、**改动永远先给你看**。

### 1.2 要解决的问题

| 痛点 | 本项目的回答 |
| --- | --- |
| 云端订阅模型的绑定：只能用厂商自带的模型/订阅 | 用户自己填 `model` / `api_key` / `base_url`，任意 OpenAI 兼容端点（官方、DeepSeek、Qwen、Kimi、GLM、OpenRouter、Ollama、vLLM、one-api 网关…） |
| 一个模型提示词打天下：解释、生成、修 bug 用同一套 prompt，效果都不极致 | 三模式独立提示词 + 独立工具集 + 独立的「允许做什么」约束 |
| AI 直接改文件，改坏了才发现 | 改动即时写入，但**立刻标记为「待审」**并落检查点：逐函数 `Keep` / `Undo`，整轮可 `Restore` 回滚 |
| AI 看不到「跟你这个问题相关」的代码 | 三级检索：文件清单 → 关键词/符号检索 → 工具驱动的按需精读 |
| 想改一段代码要先复制粘贴到聊天框 | 选中即问：右键 / 快捷键直接进 Chat、Builder、Debugger |
| 不知道 AI 到底动了哪些文件 | 写入即标红绿（QuickDiff 长在真实文件上）+ 按「函数」分组的 Keep/Undo；可一键全部 Keep，也可整轮 Restore |

### 1.3 非目标（v1 明确不做）

- ❌ 不做托管后端、不中转用户请求、不收集代码（**没有服务器**，密钥与代码只在本机与用户指定的模型端点之间流动）。
- ❌ 不做完整的 IDE 替代（不接管补全、不实现完整的 LSP）。
- ❌ 不做无审批的全自动「无人值守 / YOLO」模式（可作为 🧪 高级开关，默认关闭且需显式二次确认）。
- ❌ 不追求一次支持全语言；首期聚焦 TS/JS/Python/Go/Java/Rust 这些有成熟 LSP symbol 能力的语言。
- ❌ **不做 Web 版扩展**（vscode.dev / github.dev）：内核是 Python 子进程，拿不到 `browser` 入口。这是「Python 内核」路线的确定代价。

---

## 2. 设计原则

1. **改动即时、审阅即时（Write-then-Review）**：模型的写入立即落地并登记为「待审」；「可回滚」由检查点 + 反向补丁保证，而不是靠拦截写入。
2. **用户主权（User holds the keys）**：API Key 进 `SecretStorage`（OS 级加密凭据库），不进 `settings.json`、不进日志、不进 git。
3. **协议统一（One wire format）**：内部只有一种模型协议 —— OpenAI Chat Completions 兼容格式；异构厂商差异在适配层吃掉。
4. **可解释（Every step is visible）**：每一次工具调用、每一次检索命中、每一次 token 花费都可在面板里回放。
5. **可中断（Always cancellable）**：任何时刻一行 `AbortSignal` 就能停下循环，不产生半截写入。
6. **内核与 UI 解耦**：agent 逻辑活在 **Python 内核**里，通过 JSON-RPC 与 TS 壳通信；内核不认识 `vscode`，能脱离编辑器跑单测、也能直接接一个 CLI。

---

## 3. 术语表

| 术语 | 含义 |
| --- | --- |
| **Mode（模式）** | Chat / Builder / Debugger，决定提示词、可用工具集、输出契约 |
| **Agent Loop（智能体循环）** | `组装上下文 → 调模型 → 解析工具调用 → 执行工具 → 回填结果 → 再调模型` 的迭代过程 |
| **Tool（工具）** | 暴露给模型的可调用函数，JSON Schema 描述参数，分只读 / 写 / 执行三类 |
| **PendingEdit（待审改动）** | 一次写入的完整记录：写入前/后全文、hunk、函数分组、状态（pending / kept / undone / stale） |
| **Checkpoint（检查点）** | 影子 git 仓库里的一次快照，用于 `Restore` 整轮回滚 |
| **Keep / Undo** | 审阅动词：`Keep` 承认一个**已保存**的改动，`Undo` 反向写回。注意与 `Save` 的区别 |
| **Hunk（变更块）** | 统一 diff 中一个 `@@ ... @@` 块，是「逐条 Keep/Undo」的最小可操作单元之一 |
| **Function Unit（函数单元）** | 把若干 hunk 归并到其所属函数/方法后形成的审阅分组（默认 Keep/Undo 粒度） |
| **Context Budget（上下文预算）** | 按比例分配给系统提示词、检索、历史、输出的 token 配额 |

---

## 4. 总体架构

### 4.1 分层

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L1  UI 层（VS Code 原生 + Webview）                                       │
│  Chat/Agent 面板 · 选区右键菜单 · 快捷键 · 文件选择器(QuickPick/Tree)      │
│  QuickDiff 红绿 · 函数级 Keep/Undo 卡片 · 检查点 · 状态栏(token/费用/停止)  │
├──────────────────────────────────────────────────────────────────────────┤
│ L2  薄壳（Extension Host, Node.js / TypeScript）—— 只做「VS Code 世界的事」 │
│  activate/命令注册 · 面板宿主 · SecretStorage · WorkspaceEdit 落地         │
│  DocumentSymbol 查询 · QuickDiff/Diff 渲染 · 检查点(git) 执行 · RPC 服务端  │
├──────────────────────────────────────────────────────────────────────────┤
│ L3  Python 内核（独立子进程，JSON-RPC over stdio，不 import vscode）        │
│  AgentLoop · ModeRouter · PromptComposer · ContextEngine · ToolRegistry   │
│  PendingStore · ReviewPlanner · Guard · SessionStore · EventBus           │
├──────────────────────────────────────────────────────────────────────────┤
│ L4  出站适配层（Python）                                                   │
│  LLMClient: OpenAI 兼容（httpx + SSE + tools）                            │
│  MCPClient: stdio + Streamable HTTP · SkillLoader · 检索(ripgrep/tree-sitter)│
└──────────────────────────────────────────────────────────────────────────┘
```

**关键约束（v0.2 修订）**：Python 进程里**没有** `vscode` 模块，所以「读文件/写文件/取符号/落地 diff/存密钥」这类动作必须由 TS 壳代劳，Python 只能通过 JSON-RPC 发**意图**（`fs.read`、`edit.apply`、`symbols.get`…）。反过来，TS 壳不含任何业务逻辑（不拼提示词、不解析模型输出、不管预算）。这条边界是硬边界，一旦越界就会出现「同一段逻辑两边各写一份」的长期维护债。

> 依赖方向：L1 → L2 →（RPC）→ L3 → L4。L3 可以在没有 VS Code 的情况下降级成 CLI（用本地 fs 端口替身），这是选 Python 内核最大的收益之一：**agent 逻辑能独立跑、独立测**。

### 4.2 一次 Builder 请求的完整时序

```
用户: 在 a.ts 里选中 parseConfig()，按 Ctrl+Alt+B，输入「改成支持 .yaml 配置」
  │
  ├─(1) L2 采集「显式上下文」：选区文本 + 文件路径 + 光标位置 + 相邻 120 行
  ├─(2) L2 采集「环境事实」：workspace root / 语言 / package.json 摘要 / git 分支 / 诊断
  ├─(3) L3 ModeRouter 装配 system prompt（builder.md 覆盖层）+ 工具集（读 + apply_*）
  ├─(4) L3 ContextEngine 生成「候选上下文包」（文件清单/关键词/符号）：
  │        · 通过 RPC 向壳请求 file.list / search.grep / symbols.outline
  │        · 压缩到 token 预算内后作为首轮 messages
  ├─(5) LLMClient 流式请求（tools 声明）→ 模型返回 tool_calls: read_file / search_code
  ├─(6) ToolRegistry 执行只读工具（经 RPC 落到真实工作区）→ 结果回填 → 循环（最多 maxSteps）
  └─(7) 模型调用 apply_patch
         │
         ├─ L3 ChangeApplier: 纯 Python 算出新文本（打不上就报错返回模型，磁盘不动）
         ├─ L3 → L2 RPC `checkpoint.create`：写入**前**落一次影子 git 快照
         ├─ L3 → L2 RPC `edit.apply`：壳用单次 WorkspaceEdit.applyEdit 落盘（一个 undo 单元）
         ├─ L3 PendingStore: 登记 PendingEdit + 解析 hunk + 请求 symbols 归并为函数单元
         ├─ L2 渲染: QuickDiff 红绿长在真实文件上；面板按 文件→函数→改动 列表
         └─ 用户: 逐函数 Keep / Undo，或「全部 Keep / 全部 Undo / 恢复到检查点」
                └─ Undo → RPC `edit.apply(reverse)`；Restore → RPC `checkpoint.restore`
```

### 4.3 模块职责

| 模块 | 层 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| `src/ui/*` | L1 | 渲染会话、Keep/Undo 卡片、diff 导航（Webview 前端也是 TS） | 不拼提示词、不解析模型输出 |
| `src/shell/*`（TS） | L2 | 命令/菜单/面板宿主、SecretStorage、WorkspaceEdit、QuickDiff、DocumentSymbol、RPC 服务端 | 不含业务规则 |
| `beecode/ipc.py` | L3 | JSON-RPC 客户端（stdio）、方法注册、超时、错误映射 | 不碰 VS Code |
| `beecode/loop` | L3 | 驱动循环、状态机、取消、事件广播 | 不关心渲染 |
| `beecode/modes` | L3 | 模式定义、能力矩阵、模式切换 | 不直接读文件 |
| `beecode/prompts` | L3 | 提示词模板装配（base + overlay + memory + tools） | 不含厂商差异 |
| `beecode/llm` | L3/L4 | OpenAI 兼容客户端、SSE 解析、重试、用量统计 | 不选模型 |
| `beecode/context` | L3 | 检索编排、预算分配、压缩（具体 I/O 走 RPC） | 不直接读盘 |
| `beecode/tools` | L3 | 工具注册表、schema（pydantic）、参数校验、权限声明 | 不直接写盘 |
| `beecode/apply` | L3 | 补丁解析（unified diff）、新文本计算、反向补丁 | 不做实际写入 |
| `beecode/pending` | L3 | 待审记录、函数分组、Keep/Undo 状态机 | 不直接调 git |
| `beecode/guard` | L3 | 步数/预算/重复/无进展检测、熔断 | 不做 Keep/Undo 决策 |

---

### 4.4 VS Code 扩展的技术基线（要求 + 对接清单）

这一节回答「做一个 VS Code 插件，到底需要满足什么、要对接什么」。

#### 4.4.1 硬性要求（不做就装不上/上不了架）

| 要求 | 细节 |
| --- | --- |
| **目录 + 清单** | 扩展根目录必须有 `package.json`（**扩展清单 / manifest**）；代码入口由 `main`（Node/桌面）或 `browser`（Web 扩展）指定 |
| **必填字段** | `name`（小写、无空格、全 Marketplace 唯一）、`version`（SemVer）、`publisher`、`engines.vscode`（不能是 `*`）。扩展唯一 ID = `<publisher>.<name>` |
| **生命周期** | 入口模块导出 `activate(context)` 与（可选）`deactivate()`；`activate` 只在某个**激活事件**发生时执行一次 |
| **激活事件** | 1.74 起，`contributes.commands` 里声明的命令被调用时会**隐式激活**，无需再写 `onCommand:...`；`onStartupFinished` 会拖慢启动，能不用就不用 |
| **运行进程** | 代码跑在 **Extension Host**（独立 Node.js 进程），不能碰 DOM；所有编辑器能力必须通过 `vscode` 模块的 API，UI 自定义只能靠 Webview。**Python 内核是扩展自己拉起的子进程，不是宿主运行时**——它拿不到任何 `vscode` 能力 |
| **打包发布** | `npx @vscode/vsce package` 产出 `.vsix`；上架需要 Marketplace publisher + Azure DevOps PAT，`README.md` 会成为商店详情页正文，`icon` ≥ 128×128。若随包带 sidecar 二进制，须用 `--target win32-x64 / darwin-arm64 / linux-x64` 分平台发布 |
| **合规** | 不得静默上传用户代码/数据；有遥测必须声明并可关闭；支持 Workspace Trust 的扩展必须声明 `capabilities.untrustedWorkspaces` |

最小可运行骨架（官方 Hello World 结构）：`package.json` + `src/extension.ts` + `tsconfig.json` + `.vscode/launch.json`（F5 调试）+ `.vscodeignore`。

#### 4.4.2 本项目的「需求 → 对接点」映射

| 需求 | 对接的 VS Code 能力（贡献点 / API） |
| --- | --- |
| 侧边栏 Agent 面板 | `contributes.viewsContainers.activitybar` + `contributes.views`（`"type": "webview"`）+ `WebviewViewProvider` + `webview.postMessage` / `onDidReceiveMessage` |
| 面板前端资源 | `webview.asWebviewUri()` + `localResourceRoots` + CSP `nonce`（禁止 `unsafe-inline`） |
| 选中代码 → 三模式 | `contributes.menus["editor/context"]` + `contributes.keybindings`（`when: editorHasSelection`）+ `window.activeTextEditor.selection` + `window.showTextDocument` |
| 工作区文件列表 | `workspace.workspaceFolders` + `workspace.findFiles(include, exclude)` + `workspace.fs.*` + `createFileSystemWatcher` |
| 符号 / 函数边界 | `commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)`、`vscode.executeWorkspaceSymbolProvider` |
| 诊断（Debugger 模式） | `languages.getDiagnostics(uri)` + `languages.onDidChangeDiagnostics` |
| 红绿 diff 预览 | `workspace.registerTextDocumentContentProvider(scheme, …)` + `commands.executeCommand('vscode.diff', left, right, title)` |
| 应用改动 | `WorkspaceEdit` + `workspace.applyEdit()`（一次调用 = 一个 undo 单元） |
| API Key | `context.secrets`（`SecretStorage`：`get/store/delete/onDidChange`） |
| 配置项 | `contributes.configuration` + `workspace.getConfiguration('beeCode')` |
| 状态栏（token/停止） | `window.createStatusBarItem()` |
| 日志与排障 | `window.createOutputChannel('Bee Code')`（注意脱敏） |
| MCP 工具互操作（可选） | `contributes.mcpServerDefinitionProviders` + `lm.registerMcpServerDefinitionProvider()` |
| 原生命令/斜杠命令集成（可选） | `contributes.commands` + `menus.commandPalette`；聊天侧可另注册 Chat Participant |

#### 4.4.3 三条「要不要用官方 AI API」的技术路线

| 路线 | 能拿到什么 | 限制 | 本项目取舍 |
| --- | --- | --- | --- |
| **Chat Participant API**（`contributes.chatParticipants` + `vscode.chat.createChatParticipant`） | 长在 VS Code 原生 Chat 里：`@participant`、`/slash`、`#context`、原生历史与工具审批 UI | 输出只能走 `ChatResponseStream`（markdown 为主，不能自定义 React 树），流程被 `ChatRequestHandler` 框住。**技术上可以在 handler 里自己 `fetch` 任意端点**，限制在 UX 而非网络 | ❌ 不作为主界面（我们要自定义 Keep/Undo 与预览 UI） |
| **Language Model API**（`vscode.lm.selectChatModels`） | 调用编辑器里已注册的模型，`LanguageModelChatMessage` + `registerTool` 原生工具调用 | 只能选**已注册**的模型（典型是 Copilot 提供），受配额与管理员策略约束；不能直接指定 `base_url` | ❌ 不能作为「任意端点」的通道 |
| **Language Model Chat Provider**（`contributes.languageModelChatProviders` + `lm.registerLanguageModelChatProvider`） | **官方 BYO-key 路径**：把自有端点注册成 VS Code 模型选择器里的一个模型，配置项可用 `"secret": true` 交给 VS Code 存密钥 | 要实现消息/工具调用的双向转换与 token 计数；聊天 UI 仍是 VS Code 的 | 🧪 **加分项**：同一客户端复用到平台 |
| **自建 HTTP 客户端 + Webview 面板** | 任意 OpenAI 兼容端点、任意 UI、完全掌控循环与待审流程 | 全部自己实现（流式、工具调用、重试、渲染、可访问性） | ✅ **v1 主线** |

> 🧪 加分项（不冲突）：后续实现 `contributes.languageModelChatProviders`，把用户自带的端点**注册成 VS Code 的一个模型**，这样在原生 Chat 里也能选到「我的 DeepSeek」。注意两点：一是需要自己实现 `provideLanguageModelChatResponse` 的流式转换；二是 Copilot Business/Enterprise 管理员可以通过策略禁用 BYO key，属正常预期。

#### 4.4.4 Webview 的安全红线

- 所有资源走 `asWebviewUri`，`localResourceRoots` 限制到 `dist/webview` 目录。
- CSP 严格：`default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`。
- 消息通道双向校验：`onDidReceiveMessage` 里对 `type` 做白名单，**不信任**前端传来的路径（前端可被注入）。
- `retainContextWhenHidden` 默认关（它会让隐藏的 webview 一直吃内存），用「状态序列化 + 恢复」代替。

---

### 4.5 壳 ↔ 内核的 IPC 契约（JSON-RPC 2.0 over stdio）

选 `stdio` 而不是 TCP/HTTP 的原因很实际：**不需要端口、不需要鉴权、宿主退出时子进程跟着退出**，VS Code 自己的 LSP 与 MCP 都是这么走的。框架用 **NDJSON**（一行一个 JSON）：`JSON.stringify` 永远不会输出裸换行，所以按 `\n` 分帧是安全的，比 LSP 的 `Content-Length` 头更简单。

```
TS 壳（stdin/stdout 的服务端）  ⇄  Python 内核（子进程）
      request/response（有 id）  +  notification（无 id）
```

#### 4.5.1 内核 → 壳（Python 请求编辑器干活）

| 方法 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `fs.read` | `path, startLine?, endLine?` | `{ text, version }` | 优先用编辑器里的**未保存**内容 |
| `fs.list` | `glob, exclude?, maxResults?` | `{ paths[] }` | 壳合并 `files.exclude` + `.gitignore` |
| `search.grep` | `query, regex?, glob?, contextLines?` | `{ hits[{path,line,col,text}] }` | 壳内跑 ripgrep |
| `symbols.outline` | `path` | `{ symbols[] }` | `executeDocumentSymbolProvider` |
| `diagnostics.get` | `path?` | `{ items[] }` | `languages.getDiagnostics` |
| `edit.apply` | `path, expectedVersion, newText, reason` | `{ applied, version }` | **唯一写入通道**：单次 `WorkspaceEdit` |
| `checkpoint.create` | `label` | `{ id }` | 影子 git 快照 |
| `checkpoint.restore` | `id, scope: files\|task\|both` | `{ restored[] }` | 三档恢复 |
| `diff.open` | `path, baseText` | `{}` | 打开 `vscode.diff` 对照 |
| `confirm.ask` | `question, detail?, options[]` | `{ choice }` | 写入门闸用它问人 |
| `secrets.get` | `key` | `{ value }` | 只在会话启动时取一次，不进日志 |

#### 4.5.2 壳 → 内核（用户动作）

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| `initialize` | `protocolVersion, workspaceRoots[], modelConfig, hasKey` | 握手；版本不匹配直接失败并给可读原因 |
| `chat.send` | `sessionId, mode, text, attachments[]` | 发起一轮（`attachments` = 选区/文件引用） |
| `review.keep` / `review.undo` | `pendingIds[]` | 逐函数或批量 |
| `review.keepAll` | `sessionId` | 一键 Keep |
| `session.abort` | `sessionId` | 取消（同时 cancel 所有在飞的 RPC） |
| `model.reload` | `modelConfig` | 用户改了配置 |

#### 4.5.3 通知（无 id，单向）

- `ui.delta` `{ sessionId, text }` —— 流式文本，逐块推给面板。
- `ui.tool` `{ sessionId, name, args, status }` —— 工具开始/结束。
- `ui.usage` `{ inputTokens, outputTokens, costUsd }`。
- `pending.changed` `{ added[], updated[], removed[] }` —— 壳据此刷新 QuickDiff 与卡片。
- `log` `{ level, msg, fields }` —— 壳写进 OutputChannel（先过脱敏）。

#### 4.5.4 四条工程约定

1. **取消要能穿透**：`$/cancelRequest` 风格（带被取消的 `id`），内核收到后 `AbortSignal` 中断 HTTP 请求与工具；壳收到 `session.abort` 时同时取消自己正在执行的 RPC。
2. **密钥只走一次握手**：`apiKey` 通过 `initialize` 的**子进程 stdin** 传入，**绝不放在 argv**（`ps` 全机可见）也不放环境变量（同用户可读、易被 `env` 打进日志）。内核只在内存持有。
3. **路径策略以壳为准**：内核传来的路径可能是模型编造的，壳必须独立做「是否在工作区内 / 是否命中禁止清单」的校验（纵深防御，两边都校验）。
4. **协议要版本化**：`protocolVersion` 用整数，壳与内核不匹配时**拒绝启动**并提示「请重装扩展」，而不是带着半截语义跑。

---

## 5. 模型接入层（OpenAI 兼容）

### 5.1 为什么统一成 OpenAI 格式

- 事实标准：`POST {base_url}/chat/completions`、`messages[]`、`tools[]`/`tool_calls`、SSE 流式增量，几乎所有国内外厂商都提供兼容层（DeepSeek、Qwen/DashScope compatible-mode、Kimi、GLM、OpenRouter、Ollama、vLLM、LM Studio、one-api/new-api…）。
- 只维护一套客户端 = 只维护一份工具调用解析、一份流式状态机、一份用量统计。
- 用户「自带端点」是最高优先级需求：只要他有一个能跑 `curl` 的兼容端点，扩展就能用。

> 与 VS Code 官方 AI API 的关系：`vscode.lm.selectChatModels`（Language Model API）**只能选编辑器里已注册的模型**，无法直接指定任意 `base_url` 与用户自己的 key，因此不能作为 BYO 通道。真正「官方支持自带端点」的入口是 **Language Model Chat Provider API**（`contributes.languageModelChatProviders`），但它要求你只做「provider 侧」（把端点包装成模型），聊天 UI 与循环仍归 VS Code。本项目 v1 自建客户端以便完全掌控 Agent Loop、待审流程与预览；🧪 v2 再把同一客户端包装成 Chat Provider 反哺平台，见 [§4.4.3](#443-三条要不要用官方-ai-api-的技术路线)。

### 5.2 用户配置项

设置项写在 `settings.json`（**可进 git 的部分只有这些，没有密钥**）：

```jsonc
{
  "beeCode.model": {
    "baseUrl": "https://api.deepseek.com/v1", // 不含 /chat/completions
    "model": "deepseek-chat",
    "apiKeyId": "beeCode.apiKey.default",   // 指向 SecretStorage 的键名，不是密钥本身
    "temperature": 0.2,
    "maxOutputTokens": 8192,
    "stream": true,
    "supportsTools": true,                    // 能否原生 function calling
    "supportsVision": false
  },
  "beeCode.agent": {
    "maxSteps": 30,
    "maxTokensPerTask": 400000,
    "toolTimeoutMs": 30000,
    "defaultMode": "chat"
  },
  "beeCode.review": {
    "granularity": "function",                // function | change | file
    "autoKeepDelayMs": 0,                    // 0 = 关闭自动 Keep
    "gateGlobs": ["**/.env*", "**/*.pem", "**/.github/workflows/**"],
    "gateBatch": { "files": 5, "lines": 300 } // 超过则写前确认
  }
}
```

首次使用走「设置向导」（`beeCode.model.configure` 命令）：

1. 输入 `base_url`（提供常用服务商下拉：DeepSeek / OpenAI / Qwen / Kimi / GLM / OpenRouter / 本地 Ollama…）。
2. 输入 `model`（🔬 输入后调 `GET {base_url}/models` 拉候选列表，失败则允许手填）。
3. 输入 `api_key`（`inputBox({ password: true })`），立即写入 `context.secrets.store(...)`，**永不回显**。
4. 发一个最小 `ping` 请求（1 token）验证连通性，失败给出 HTTP 状态与可读原因。

### 5.3 密钥存储

| 位置 | 是否允许放 key | 说明 |
| --- | --- | --- |
| `settings.json`（用户/工作区） | ❌ | 明文、会被同步、会被 git 提交 |
| `context.secrets`（SecretStorage） | ✅ **唯一位置** | 底层由 OS 凭据库加密（macOS Keychain / Windows DPAPI / Linux libsecret） |
| `globalState` / `workspaceState` | ❌ | 明文 JSON |
| 日志/遥测/崩溃上报 | ❌ | 统一走 `redact()` 过滤（`sk-*`、`Bearer *`、URL query 里的 key） |
| 内存（请求时） | ✅ | 仅存活于发请求的那几毫秒，`AbortSignal` 结束即释放 |

`SecretStorage` 的关键性质（决定了它为什么是唯一正确位置）：**落盘加密**、**不参与 Settings Sync**、桌面端底层走 Electron `safeStorage`（即 OS 凭据库）。相反，`contributes.configuration` 写入的 `settings.json` 是**明文且会随 Settings Sync 同步到其他机器/被 dotfiles 仓库提交**——这是「密钥泄露」最常见的来源。

工业界的额外做法（本项目全部采纳，见 [§12](#12-安全与隐私)）：

- **子进程环境变量清洗**：调用 MCP server / 命令时，把 `*TOKEN*`、`*SECRET*`、`*PASSWORD*`、`*KEY*`、`*AUTH*` 之类的环境变量剔除，避免顺手把 key 递给第三方进程（Claude Code 的做法）。
- **URL 与错误信息脱敏**：日志与错误提示里把 URL 中的凭据替换成 `REDACTED`，且不打印「展开后」的完整 URL。
- **凭据类型的显式选择**：像 Codex 那样让用户选 `keyring` / `file` / `ephemeral`，而不是偷偷落到明文文件；本项目只提供 `SecretStorage`，等价于 `keyring`。
- **反例**：把 key 写进 `config.yaml` / `.env` / YAML 配置是 CLI 工具的常见做法（Continue、Aider 都如此），对一个 GUI 产品来说是不可接受的设计——用户看不到这个文件，也就不会去保护它。

### 5.4 请求与响应约定

```python
# beecode/llm/types.py
class ChatRequest(BaseModel):
    model: str                              # 来自设置
    messages: list[ChatMessage]             # system | user | assistant | tool
    tools: list[ToolSpec] | None = None     # JSON Schema
    tool_choice: Literal["auto", "none"] | dict | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    stream: bool = True

class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[ContentPart] | None = None
    tool_calls: list[ToolCall] | None = None    # assistant 侧
    tool_call_id: str | None = None             # tool 侧
    name: str | None = None
```

- **流式**：用 `httpx` 的 `client.stream()` 解析 SSE `data: {...}`，累积 `delta.tool_calls[i].function.arguments` 片段，按 `index` 归并（各厂商最容易出差异的地方：有的不给 `index`，有的把 `arguments` 一次性给完）。
- **首包/超时**：`httpx.Timeout(connect=15, read=90)`；空闲超时 60s 用 `asyncio.wait_for` 包一层；取消走 `asyncio.Task.cancel()`（对应壳的 `session.abort`）。
- **用量**：优先读 `usage`；没有则用 `tiktoken` 估算并标注「估算值」。

### 5.5 兼容性矩阵与降级（🔬 逐家 PoC）

| 家族 | endpoints | 已知差异 | 处理 |
| --- | --- | --- | --- |
| OpenAI 官方 | `/v1` | 新模型用 `max_completion_tokens`；`tool_choice` 支持完善 | 按模型名映射字段 |
| DeepSeek | `/v1` | 有 `reasoning_content` 独立字段；部分模型不支持 `tool_choice` 强制 | 丢弃/折叠 reasoning，`tool_choice` 降级为 `auto` |
| Qwen / DashScope | `/compatible-mode/v1` | 部分模型多模态与工具不能同时开 | 会话级关闭 vision |
| Moonshot / Kimi | `/v1` | 长上下文，`max_tokens` 上限不同 | 读 `/models` 或按预设 profile |
| 智谱 GLM | `/api/paas/v4` | 字段命名略有差异 | profile 覆盖 |
| Ollama / vLLM / LM Studio | `/v1`（本地） | 可能不支持 tools、不支持 `stream_options` | 不支持 tools 时走 **JSON 模式降级**（见下） |
| 聚合网关（one-api/new-api/OpenRouter） | `/v1` | 上游差异被网关吃掉，但错误码不规范 | 统一错误归一化 |

**工具调用降级方案**（`supportsTools: false` 时）：提示词里给出严格 JSON 输出协议，要求模型只输出一个 `json` 代码块，内容形如 `{"tool":"read_file","args":{...}}`；内核把它解析成「伪 tool_call」后照常走同一套执行与审批链路，解析失败时重试并附带「上一次格式错误」的纠正提示。这样连最朴素的本地模型也能跑 Builder。

### 5.6 错误处理

| 情况 | 策略 |
| --- | --- |
| 401/403 | 不重试，提示「密钥无效/无权限」，给「重新配置」按钮 |
| 429 | 指数退避 + `Retry-After`，最多 3 次，UI 显示倒计时 |
| 5xx / 网络中断 | 退避重试 2 次；流式中断则保留已产出文本并允许「继续生成」 |
| 上下文超限（400 context_length_exceeded） | 触发压缩（[§8.4](#84-压缩与记忆)）后重试一次 |
| 响应 JSON 不合法（tool_calls 坏掉） | 追加「纠正提示」重试 1 次，仍失败则把原始文本给用户并报错 |

---

## 6. 三模式设计

### 6.1 能力矩阵

| 维度 | 💬 Chat | 🏗 Builder | 🐞 Debugger |
| --- | --- | --- | --- |
| 目标 | 解释、答疑、读懂代码、讲解设计 | 生成/重构/补全代码，产出改动 | 定位缺陷、给出修复，含回归验证 |
| 工具集 | 只读（`list_files` / `read_file` / `search_code` / `file_outline` / `get_diagnostics`） | 只读 + `apply_patch` / `create_file` / `delete_file`（直接写入 + 待审） | 只读 + `apply_*` + 🧪`run_command`/`run_test` |
| 是否允许改文件 | ❌ 硬性禁止（工具列表里根本没有写工具） | ✅ 直接写入，写入即标记待审 | ✅ 直接写入，写入即标记待审 |
| 输出契约 | 自然语言 + `file:line` 引用 + 可选 Mermaid 图 | 改动提案 + 变更说明 + 影响分析 | 根因 → 证据 → 修复提案 → 验证方式 |
| 默认温度 | 0.3 | 0.5 | 0.2（求确定性） |
| 典型触发 | 选中代码 `Ctrl+Alt+K`、`@chat` | 选中代码 `Ctrl+Alt+B`、`/build` | 选中代码 `Ctrl+Alt+D`、诊断右键「用 Debugger 修」 |
| 结束条件 | 给出回答（可不调用工具） | 至少产出一条待审改动，或明确「无法完成」 | 待审改动 + 验证结论 |

> 模式隔离的工程要点：Chat 模式**不要**在 `tools[]` 里声明写工具再靠提示词禁止 —— 提示词是可以被绕过的，正确的做法是「模型根本看不见这个工具」。这是权限最小化（least privilege）在 Agent 上的直接体现。

### 6.2 提示词结构

```
system =
  ┌ BASE（三模式共享） ────────────────────────────────
  │ 角色定位 / 可用工具与使用纪律 / 输出格式约定
  │ 安全红线（不写密钥、不臆造 API、不确定就说不知道）
  │ 环境事实（workspace 名、根路径、语言、git 分支、时间）
  │ 项目规则（AGENTS.md / .beecode/rules/*.md 注入）
  ├ MODE OVERLAY（互斥，来自 modes/*.md）─────────────
  │ chat.md | builder.md | debugger.md
  └ 运行时附加 ───────────────────────────────────────
  │ 本轮选中上下文 / 已读文件清单 / token 预算提示
```

之所以采用「BASE + OVERLAY」而不是三份完整 prompt：共享部分只维护一份，避免三份提示词漂移；模式差异集中在 30~60 行的覆盖层里，评审时一眼能看出差异。

### 6.3 Chat 模式提示词（骨架）

```markdown
# Role
你是团队里的资深代码讲解员。你的任务是让提问者在最短时间内**真正理解**这段代码，
而不是给他一段重新写的代码。

# Rules
- 只读：你没有任何写文件的工具，也不要输出「请把第 12 行改成」之外的整文件代码。
- 每次结论都要有出处：`路径:行号`，并引用你实际读到的代码片段（≤5 行）。
- 先给「一句话结论」，再给「展开解释」，最后给「需要注意的坑」。
- 涉及调用链时，用有序列表描述 A → B → C，并指出每一步的依据文件。
- 不确定的地方明确写「未验证」，禁止编造不存在的函数或配置项。

# Output
## 结论
## 逐段解释
## 依赖与调用链
## 风险与建议
```

### 6.4 Builder 模式提示词（骨架）

```markdown
# Role
你是实现者。你负责产出**可提交的改动**，改动必须最小、可读、与现有风格一致。

# Workflow（严格遵守）
1. 先探索：用 list_files / search_code / read_file 找到所有需要改的地方，不要凭猜测写代码。
2. 复述需求：用 3 行以内说明你理解的任务与边界（含你打算不做什么）。
3. 再动笔：用 apply_patch 写入改动，一次一个文件，patch 用标准 unified diff。
   （写入后会进入「待审」状态，用户可逐函数 Keep 或 Undo —— 你不需要在回复里再请求一次批准。）
4. 自检：改完后检查导入、类型、命名、错误处理、边界条件。

# Rules
- 不允许改动与本任务无关的代码；不允许顺手「优化」格式。
- 不允许删除已有的错误处理、日志、注释，除非任务明确要求。
- 新增依赖必须在说明里显式列出，并给出理由。
- 无法完成时，说明卡在哪一步、缺什么信息，不要产出半成品。

# Output
## 改动摘要（文件 → 函数 → 一句话）
## 影响面（调用方 / 测试 / 配置）
## 待确认（如有）
```

### 6.5 Debugger 模式提示词（骨架）

```markdown
# Role
你是缺陷定位专家。你的第一产物是**根因假设与证据链**，第二产物才是修复补丁。

# Workflow
1. 复现假设：从报错栈/诊断/用户描述里提取「症状 → 触发路径 → 可疑假设」。
2. 证据收集：读相关函数体与调用点，必要时读测试与配置；每条假设必须标注「支持/反驳」的证据（`路径:行号`）。
3. 收敛：排除假设，锁定根因；若无法锁定，输出「还需哪些信息」而不是硬猜。
4. 修复：apply_patch 给出最小修复，并在说明里写「为什么这样改能消除根因，而不只是消除症状」。
5. 回归：说明这次修复需要补哪些测试用例（可选：用 run_test 验证）。

# Rules
- 禁止「先把异常 try/catch 掉」式的伪修复，除非用户明确要求容错。
- 区分「根因」与「触发条件」，两者都要写清楚。
- 任何修复都必须说明副作用与回滚方式。

# Output
## 根因
## 证据链（假设 → 证据 → 结论）
## 修复方案与补丁
## 验证与回归建议
```

### 6.6 模式切换

- UI 顶部三段式切换器（Chat / Builder / Debugger），当前模式决定「输入框 placeholder」与「工具栏可用按钮」。
- 同一会话内可切换模式：**历史保留**，但切换时会插入一条 system 级「模式变更」提示，并把工具集整体替换（模型不会带着上一模式的工具记忆产生幻觉）。
- 快捷键 / 右键菜单直接「带选区进入某模式」，见 [§9](#9-选区快捷入口)。

---

## 7. Agent 内核与循环

### 7.1 循环状态机

```
IDLE ──submit──▶ ASSEMBLING ──▶ THINKING ──┬─(tool_calls)──▶ EXECUTING_TOOL ──▶ THINKING
                                           ├─(final text)──▶ REVIEWING ──▶ DONE
                                           └─(error)──────▶ RETRY/FAILED
任意状态 ──cancel──▶ ABORTED（丢弃 sandbox 未提交内容）
REVIEWING ──approve──▶ APPLYING ──▶ DONE
```

```ts
// beecode/loop/agent.py（示意）
async def run(session: Session, turn: UserTurn) -> AsyncIterator[LoopEvent]:
    guard = Guard(session.budget)
    step = 0
    while True:
        step += 1
        if reason := guard.should_stop(step):
            yield LoopEvent("stopped", reason=reason)
            return

        messages = session.prompts.assemble(turn)          # 预算裁剪后
        async for ev in session.llm.stream_chat(
            ChatRequest(model=session.model, messages=messages,
                        tools=session.mode.tools, stream=True)
        ):
            if ev.type == "text":
                yield LoopEvent("delta", text=ev.text)
            elif ev.type == "tool_call":
                yield LoopEvent("tool_start", call=ev.call)

        assistant = await stream.done()
        session.history.append(assistant)

        if not assistant.tool_calls:
            yield LoopEvent("final", text=assistant.text)
            return

        for call in assistant.tool_calls:
            tool = registry.get(call.name)                 # 未注册 -> 回填错误，不崩
            try:
                args = tool.schema.model_validate_json(call.args)   # pydantic 校验
            except ValidationError as e:
                yield result_event(call, f"参数错误：{e}")          # 可读错误回填
                continue
            result = await tool.run(args, session.ports)    # 只读立刻返回；写工具经 RPC 落盘并登记待审
            session.history.append(tool_message(call.id, result))
            yield LoopEvent("tool_end", call=call, result=result)
```

### 7.2 工具清单

| 工具 | 类型 | 主要参数 | 说明 |
| --- | --- | --- | --- |
| `list_files` | 只读 | `glob`, `maxDepth`, `includeIgnored?` | 返回工作区文件树（Git-aware） |
| `read_file` | 只读 | `path`, `startLine?`, `endLine?` | 分片读取，单次上限 400 行，超出提示分段 |
| `search_code` | 只读 | `query`, `regex?`, `glob?`, `contextLines?` | ripgrep 后端，返回 `路径:行:内容` |
| `file_outline` | 只读 | `path` | 符号大纲（函数/类/方法 + 行号区间） |
| `get_diagnostics` | 只读 | `path?`, `severity?` | 读 LSP 诊断（编译错误、lint） |
| `apply_patch` | 写（写盘 + 待审） | `path`, `patch(unified diff)`, `reason` | 唯一改文件入口；先落检查点，再单次 `applyEdit`，然后登记 `PendingEdit` |
| `create_file` | 写（写盘 + 待审） | `path`, `content`, `reason` | 新建文件；同样进入待审 |
| `delete_file` | 写（写盘 + 待审） | `path`, `reason` | 删除文件；强制单独确认，Undo 时用 `baseText` 重建 |
| `run_command` | 执行 🧪 | `command`, `cwd?`, `timeoutMs?` | 默认关闭；需 allowlist + 每次审批 |
| `run_test` | 执行 🧪 | `target`, `framework?` | 识别 jest/pytest/go test 等后执行 |
| `load_skill` | 元 | `name` | 按需加载技能正文（见 [§13](#13-skill-与-mcp-集成)） |

工具定义要求：**描述写给模型看**（何时用、何时不用、返回什么），**schema 写给校验用**（`additionalProperties: false`），**权限写给审批用**（`kind: 'read' | 'write' | 'exec'` + `readOnlyHint` 类似物）。

### 7.3 循环守卫（防死循环 / 防烧钱）

| 守卫 | 默认阈值 | 触发行为 |
| --- | --- | --- |
| 步数上限 `maxSteps` | 30 | 停止循环，输出「已达步数上限」+ 当前进度摘要 + 继续按钮 |
| token 预算 `maxTokensPerTask` | 400k | 同上，并给出「本次预计花费」 |
| 重复动作检测 | 相同 `(tool, args)` 哈希连续 2 次 | 插入纠正提示「你刚做过同样的调用，请换策略」，连续 3 次则停止 |
| 无进展检测 | 连续 4 步没有新的文件被读取、没有新的待审改动 | 停止并询问用户「是否补充信息」 |
| 错误熔断 | 同一工具连续失败 3 次 | 禁用该工具本轮，回填「工具不可用，请改用 X」 |
| 单工具超时 | 30s（命令类可配） | 中止该工具，回填超时错误（不中断整个循环） |
| 用户中断 | 随时 | `AbortSignal` → 丢弃 sandbox 内容 → 保留已产出文本 |

> 设计要点：守卫要「先提醒、再停止」。直接硬停会让用户觉得模型「卡住了」；先插入一条系统提示纠正策略，往往能自愈。

---

## 8. 工作区感知与上下文工程

目标：**让模型在需要的时候看到正确的代码，而不是一次性塞进整个仓库。**

### 8.1 文件清单索引（用户可选的「文件列表」）

需求里明确要「根据工作区内所有文件生成一个文件列表，让用户选择指定文件针对性阅读」。实现分三层：

| 层 | 机制 | 说明 |
| --- | --- | --- |
| 采集 | `vscode.workspace.findFiles('**/*', excludeGlob, 5000)` | 一次扫描拿全量路径。`exclude` 传 `undefined` 会应用 `files.exclude`+`search.exclude` 默认值，传 `null` 则**完全不过滤**——这一对语义很容易搞反 |
| 过滤 | 默认排除 + `.gitignore` 解析 + 扩展名/大小/二进制 | ⚠️ **`findFiles` 不会读 `.gitignore`**，只认 `files.exclude` / `search.exclude`。要尊重 `.gitignore` 必须自己补：用 `ignore` 这个 npm 包（gitignore 规范的完整实现）逐路径 `ignores(relPath)`，或改用 `workspace.findTextInFiles`（ripgrep 后端，`useIgnoreFiles` 默认开）做检索 |
| 刷新 | `createFileSystemWatcher` 增量更新 | 新增/删除/重命名只更新索引条目，不全量重扫；`.gitignore` 变化时重建 |

具体规则：内置默认（`**/node_modules/**`、`**/.git/**`、`**/dist/**`、`**/out/**`）+ 用户 `files.exclude`/`search.exclude` + `.gitignore` 三份合并；二进制（前 8KB 含 NUL 字节）直接排除；> 512KB 只入索引不给内容。多根工作区里用 `new vscode.RelativePattern(folder, '**/*.ts')` 限定在某个 root 内，否则很容易把别的项目也扫进来。

UI 有三处：

1. **QuickPick 多选**（最快）：`showQuickPick(items, { canPickMany: true, matchOnDescription: true })`，item 的 `description` 放「目录 · 语言 · 行数」，用户输几个字母就能筛；选中项进「固定上下文（pinned）」。
2. **TreeView 文件树**：按目录折叠，带「最近修改 / 当前 git 改动 / 未保存」三个虚拟分组。
3. **面板内 `@` 提及**：输入 `@` 触发同一个索引的模糊搜索，选中后作为 chip 挂在输入框上。

「固定上下文」语义很关键：用户选中的文件**不参与预算裁剪**，始终全文进上下文（预算不够时提示用户「已固定 3 个文件，约 12k token」）。这解决的是「我说了算，别给我裁剪掉」的控制感问题。

### 8.2 检索三路

```
用户问题
  ├─(A) 关键词/正则检索：ripgrep（子进程或 node 实现），命中行 ± contextLines
  ├─(B) 符号检索：DocumentSymbol 结果建成轻量符号表 {name, kind, path, range, container}
  │        └─ 支持「同名定义 / 近似名 / 调用点」三类命中
  └─(C) 结构邻域：import/require 解析出 1-hop 依赖与被依赖，作为「顺藤摸瓜」候选
        ↓
    排序打分：路径相关度(同目录/同名) + 命中密度 + 修改新鲜度(git log) + 是否被 pinned
        ↓
    预算裁剪 → 生成「候选上下文包」→ 模型可再主动 read_file 精读
```

- **不做**默认的向量索引：全量 embedding 有索引成本、陈旧问题和「把私钥/密钥文件也塞进向量库」的隐私风险。业界两种主流替代是 **agentic search**（Claude Code / Codex CLI / Cline：只给检索工具，让模型自己决定读什么）和 **结构化 repo map**（Aider：只把符号与引用图压成骨架，不整库向量化）。本项目优先走 agentic search 为主、repo map 为辅。🧪 向量检索作为可选增强（本地 embedding 模型），默认关闭，见 [§14](#14-工业界参考) 的对比。
- Aider 的 **repo map** 思路（tree-sitter 抽取符号 + 引用图 + 图排序压到预算内）值得借鉴：它把「整个仓库的结构」压成 1~4k token 的骨架，对「跨文件改一处」类任务性价比很高。🔬 M2 之后作为 `file_outline` 的批量版本引入。

### 8.3 上下文预算

```ts
interface ContextBudget {
  window: number;          // 模型上下文窗口（按 profile 预设）
  reserveForOutput: number;// 输出预留，默认 20%
  alloc: {
    system: number;        // 6k：BASE + OVERLAY + 规则
    pinned: number;        // 用户固定文件，按需但设上限
    retrieval: number;     // 40%：检索命中
    history: number;       // 30%：对话历史
    toolResults: number;   // 工具返回（与 history 共享，单条 > 8k 自动摘要）
  };
}
```

### 8.4 压缩与记忆

| 触发 | 动作 |
| --- | --- |
| 估算 token > 窗口 × 80% | ① 折叠工具结果：只保留命中行 ± 10 行，大块内容换成「已读 `path` L10-L200，摘要：…」；② 旧轮次摘要：由模型生成结构化摘要（**已确认事实 / 已读文件 / 已写入的改动 / 未决问题**）；③ 保留「首轮任务描述 + 最近 3 轮原文」 |
| 用户点「压缩上下文」 | 立即执行 ②③，面板显示「压缩前 42k → 压缩后 9k」 |
| 新会话 | 从 `.beecode/memory/notes.md` 与项目规则恢复长期记忆 |

记忆分三层（与工业界一致）：

1. **工作记忆**：当前会话 messages（内存 + `workspaceState` 落盘以便重启恢复）。
2. **会话摘要**：压缩产物，可回放。
3. **长期项目记忆**：`.beecode/rules/*.md`（人类写的规则，随 git 提交）+ `.beecode/memory/notes.md`（Agent/用户显式追加的事实，如「本仓库用 npm 不用 pnpm」「测试跑 `npm run test:unit`」）。同时兼容读取根目录 `AGENTS.md`。

> 记忆写入必须**显式**：模型想写记忆得调 `remember(note)` 工具并让用户确认，避免「模型自己给自己写规则」导致行为漂移。

### 8.5 新鲜度

- 每个文件缓存带 `mtime + hash`；`onDidChangeTextDocument` 时优先用编辑器内的**未保存**内容（用户经常改完没存就问）。
- 写入时记录 `document.version` + 内容 hash；此后用户手改了同一段 → 相关 `PendingEdit` 标 `stale`，Undo 前需重定位（详见 [§10.6](#106-冲突与并发)）。

---

## 9. 选区快捷入口

### 9.1 交互

| 入口 | 行为 |
| --- | --- |
| 选中代码 → 右键 → `Bee Code: 解释 / 生成改动 / 排查` | 打开面板，把选区作为引用 chip 挂上，自动填入模式对应的默认指令 |
| 选中代码 → `Ctrl+Alt+K / B / D` | 同上，键盘直达（macOS 用 `Cmd+Alt+*`） |
| 无选区 → 快捷键 | 自动取「光标所在的整个函数」（用 DocumentSymbol 反查），再走上面的流程 |
| 诊断（红波浪线）→ 右键 `用 Debugger 修` | 带上诊断信息 + 所在函数进 Debugger |
| 终端选中输出 → 右键 | 作为「报错上下文」进 Debugger（v1.1） |

### 9.2 实现要点

1. **声明**：`contributes.menus.editor/context` + `contributes.keybindings`，两者都用 `when: "editorHasSelection"` 控制（无选区时菜单隐藏）；`group: "beeCode@n"` 保证排序在同一组内。
2. **采集**：`vscode.window.activeTextEditor` → `selection`（支持多选区：逐个取，合并去重）→ `document.getText(range)`；同时记录 `uri`、`range.start.line/end.line`、语言 ID。
3. **上下文扩展**：用 `vscode.executeDocumentSymbolProvider` 拿到光标/选区所属的符号，向上扩到函数边界（避免只给半截 `if` 块）；再补「文件头 40 行（imports）+ 相邻 20 行」作为最小可理解单元。
4. **投递**：命令里 `await vscode.commands.executeCommand('beeCode.chatView.focus')` 后 `postMessage({ type: 'attachSelection', payload })`；面板渲染成 chip，用户可删、可再选。
5. **大选区策略**：> 200 行时只附 `file_outline` + 选区首尾各 40 行，并在 chip 上标注「已折叠（共 800 行）」，模型需要时再用 `read_file` 精读。
6. **不打断输入**：若用户正在输入，把选区插入为 chip 而非覆盖草稿。

> 工程细节：`when` 条件里不要用 `resourceScheme == file` 之外的复杂表达式，否则在 diff 编辑器、notebook、虚拟文档里会误显示。对只读文档（diff 侧、预览侧）要提前 `return`。

---

## 10. 改动落地：写入 + 待审（Write-then-Review）

> **方向修正（v0.1）**：早期设计是「内存 Overlay 沙箱 → 预览 → 逐函数审批 → 落地」（先审后写）。调研后改为工业主流范式「**直接写入工作区 → 标记待审 → Keep / Undo**」（先写后审）。下文是改后的方案，取舍理由见 [§14.10](#1410-为什么最终改用主流范式先写后审)。

### 10.1 为什么要改

| 维度 | 先审后写（Overlay） | 先写后审（主流） |
| --- | --- | --- |
| 磁盘状态 | 审批前零改动 | 写盘即有改动，可一键 Undo / 恢复到检查点 |
| 与编辑器生态 | 割裂：自己的虚拟文档、自己的预览、自己的 undo | **融合**：走 `WorkspaceEdit` 进原生 undo 栈，走 QuickDiff 得原生红绿 + gutter |
| 工程量 | 预览、多文件 diff、虚拟文件系统全自建 | 预览复用 VS Code 能力，只做「待审记录 + 分组 + 回滚」 |
| 崩溃/断电 | 提案丢失，工作区干净 | 改动已在盘上，靠检查点恢复 |
| 用户心智 | 「AI 提案给我审」 | 「AI 改了，我看一眼决定留不留」——与 Copilot/Cursor/Cline 一致 |

主流之所以是主流：**审核的成本远低于自建预览的成本**，而 VS Code 已经把「红绿 + 逐改动回退」做成了基础设施（SCM QuickDiff）。我们保留 Overlay 的两个真实好处，降级为**写入门闸**（[§10.7](#107-写入门闸guardrails)）：敏感文件先问、大批量先问。

### 10.2 写入路径：一次改动 = 一个 undo 单元

```ts
// src/shell/apply.ts（TS 壳侧实现；Python 内核只通过 RPC 请求它）
const doc = await vscode.workspace.openTextDocument(uri);
const before = doc.getText();
const after = applyUnifiedPatch(before, patch);   // 纯函数；打不上就抛错，绝不半写
const edit = new vscode.WorkspaceEdit();
edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), after);
const ok = await vscode.workspace.applyEdit(edit); // 单次调用 = 单个 undo 步
```

四条硬规则：

1. **用 `WorkspaceEdit` 而不是 `TextEditor.edit`**：不受编辑器是否可见影响、可一次跨多文件、天然进 undo 栈。
2. **同一文件的多处改动合并成一个 `WorkspaceEdit`**：否则用户要按 N 次 `Ctrl+Z`。跨文件同理，一次 `applyEdit` 搞定（但注意 [§11.5](#115-与-git-及工作区状态的关系) 的原子性说明）。
3. **写入前必须已存在检查点**（[§10.5](#105-检查点checkpoint回滚的地基)），写入后立刻登记 `PendingEdit`。
4. **先算后写**：`applyUnifiedPatch` 是纯函数，算不出结果就报错返回模型，磁盘不动。

### 10.3 待审记录（PendingEdit）

```ts
interface PendingEdit {
  id: string;                    // 稳定 id，UI 与命令都用它
  taskId: string; mode: 'builder' | 'debugger';
  path: string;
  baseText: string;              // 写入前全文（Undo 与预览左侧用）
  appliedText: string;           // 写入后全文
  appliedVersion: number;        // 写入后的 document.version
  hunks: Hunk[];                 // 解析 patch 得到
  units: FunctionUnit[];         // 按符号归并后的审阅分组
  status: 'pending' | 'kept' | 'undone' | 'stale';
}

interface Hunk {                 // 与统一 diff 一一对应
  id: string;                    // `${path}#${index}`
  oldStart: number; oldLines: number;
  newStart: number; newLines: number;
  header: string;
  lines: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }>;
}

interface FunctionUnit {
  id: string;                    // `${path}::${symbolPath}`
  symbolPath: string;            // "ConfigParser.parse" / "<top-level>"
  kind: 'function' | 'method' | 'class' | 'module';
  range: { startLine: number; endLine: number };
  hunkIds: string[];
  risk: 'low' | 'medium' | 'high';
}
```

- 一次 `apply_patch` 产生**一条** `PendingEdit`；同一文件被改两次就是两条（按时间排序，倒序 Undo）。
- 面板按 `文件 → 函数 → hunk` 三级聚合展示，把多条 `PendingEdit` 合并进同一棵树。
- `stale`：写入之后用户又手改了这段代码，Undo 前需要重定位（[§10.6](#106-冲突与并发)）。

### 10.4 三个动词，严格区分

| 动词 | 语义 | 实现 | 会不会写文件 |
| --- | --- | --- | --- |
| **Keep** | 承认这次改动，清掉待审标记 | 只改 `status`，记一条审计日志 | ❌ 不写（文件早就写好了） |
| **Undo** | 撤销这一组改动（回到 base 的对应行） | 反向 patch → `TextEdit` → `applyEdit` | ✅ 写（反向写回） |
| **Restore** | 回到某个检查点（整轮/整个任务） | 影子 git 恢复 | ✅ 批量写 |

**最关键的一条概念澄清**（VS Code 官方语义）：*Keep 不是 Save*。文件在 AI 改完的那一刻就已经保存了；Keep 的含义是「我不再需要回退这段改动了」。所有围绕「待审」的文案都必须遵守这个区别，否则用户会以为不点 Keep 就不会落盘。

### 10.5 检查点（checkpoint）：回滚的地基

采用**影子 git 仓库**（Cline 的做法），与项目 `.git` 完全隔离：

```
<globalStorage>/bee-code/shadow.git     ← GIT_DIR（不污染项目）
<workspace>                             ← GIT_WORK_TREE
```

```bash
git init --bare "<globalStorage>/bee-code/shadow.git"
git --git-dir="<shadow>" --work-tree="<ws>" add -A
git --git-dir="<shadow>" --work-tree="<ws>" commit -m "checkpoint: turn 3"
# 查看/恢复：
git --git-dir="<shadow>" --work-tree="<ws>" status --short
git --git-dir="<shadow>" --work-tree="<ws>" checkout -- <path>
```

规则：

- **时机**：每次 `apply_patch` **之前**落一次快照（保证「写入可回滚」），一轮任务结束时再落一次（供 Restore Task）。
- **范围**：默认只快照「本任务涉及的文件 + 当前未提交的改动」，避免大仓库被 `add -A` 拖慢（Cline 明确记录过这个痛点：仓库越大、checkpoint 越占空间越慢）。
- **保留**：最近 50 个（`beeCode.checkpoint.retention`），超出按时间淘汰。
- **三档恢复**：`Restore Files`（只回文件）/ `Restore Task`（回对话 + 文件）/ `Restore Both`。
- **降级方案**：环境里没有 git 时，退化为 `<globalStorage>/bee-code/snapshots/<ts>/<relPath>` 的纯文件快照（能恢复、不能 diff）。

### 10.6 冲突与并发

| 场景 | 处理 |
| --- | --- |
| Undo 时文件已被用户改过 | 比对当前文本与 `appliedText`：一致 → 直接反向；不一致 → 按上下文重定位（jsdiff `applyPatch` 的 `fuzzFactor`、或 `git apply --3way`）；仍失败 → 标 `stale`，弹窗让用户选「保留现状 / 覆盖 / 查看差异」 |
| 用户正在同一文件里编辑 | 等编辑停下（`onDidChangeTextDocument` debounce ~300ms）再 Undo；或直接提示「请先停止编辑」 |
| 同一文件有多条 PendingEdit | **倒序** Undo（后写的先撤），否则行号 / 内容会错位 |
| 两个窗口 / 两个任务同时改同一文件 | 用 `document.version` + 内容 hash 双校验；写入串行化（每文件一个互斥队列） |
| 写入过程中文件被外部程序改 | `applyEdit` 返回 false → 重新读、重算、重试一次；仍失败则放弃并报错 |

### 10.7 写入门闸（Guardrails）

保留 Overlay 范式真正有价值的部分——**在写之前挡一下**，只挡高风险：

| 门闸 | 默认 | 说明 |
| --- | --- | --- |
| 敏感路径写前确认 | 开 | `.env*`、`*.pem`、`*.key`、`id_rsa*`、`.git/**`、`.github/workflows/**`、`package.json` 的 `dependencies` 段（可配 `beeCode.review.gateGlobs`） |
| 大批量写前确认 | 开 | 单次 > 5 个文件 或 +/− 合计 > 300 行 → 「将改动 8 个文件 +420 −130，继续？」 |
| 删除文件 | 开 | 删除类改动单独确认，且强制先落检查点 |
| 自动 Keep | 关 | 可设延时（对标 `chat.editing.autoAcceptDelay`），倒计时内可撤销 |
| 全部关闭 | 允许 | 设置项里叫 `unsafe`，UI 上标黄 |

### 10.8 仍然不执行代码

写入 ≠ 执行。`run_command` / `run_test` 仍默认关闭，需要 OS 级沙箱（[§14.3](#143-沙箱四个层级越往下越真隔离)）才可开启。**审批可以被说服，沙箱不能**——这条结论不因为改了审阅范式而改变。

---

## 11. 预览、逐函数 Keep/Undo 与回滚

### 11.1 红绿从哪来：三种方案，从轻到重

| 方案 | 红绿来源 | 集成成本 | 用途 |
| --- | --- | --- | --- |
| **A. `vscode.diff`** | diff 编辑器渲染两份文档 | 极低 | 「看这次改了什么」的全量对照 |
| **B. `vscode.changes`** | 内置「更改编辑器」多文件视图 | 低 | 「本轮改了 8 个文件」的总览 |
| **C. SCM QuickDiff** | VS Code 在**真实文件**里画红绿 + gutter 图标 | 中 | 长期主形态：改动就长在代码上，旁边就是回退按钮 |

方案 C 值得展开，因为它把「审阅 UI」变成了平台能力：

```ts
// src/shell/quickdiff.ts（TS 壳侧）
const sc = vscode.scm.createSourceControl('beeCode.pending', 'Bee Code 待审');
sc.quickDiffProvider = {
  // 只要告诉 VS Code「这个文件的原始内容在哪」，红绿它自己算
  provideOriginalResource(uri) { return baseUriFor(uri); }   // beecode-base: 虚拟文档
};
// 逐改动菜单：handler 收到 VS Code 切好的 LineChange[]
vscode.commands.registerCommand('beeCode.revertChange', (uri, changes: vscode.LineChange[], index: number) => {
  revertHunks(uri, changesToHunks(changes.slice(index, index + 1)));
});
// package.json: contributes.menus["scm/change/title"]
```

- 这是**唯一**能拿到「VS Code 已经帮你把 diff 切成单条 `LineChange`」的入口，等于白送「逐改动回退」的 gutter UI。
- 它要求「改动已经在文件里」——这与写盘范式天然契合，也是我们改范式的原因之一。
- A/B 仍然保留：`vscode.diff` 用于「函数级精确对照」，`vscode.changes` 用于「本轮总览」。
- ⚠️ diff 编辑器默认 `ignoreTrimWhitespace: true`，**只改缩进的改动会显示成无变化**；审阅场景要显式关掉。

### 11.2 从 hunk 到「函数单元」

```ts
async function groupByFunction(base: PendingEdit, symbols: DocumentSymbol[]): FunctionUnit[] {
  const units = new Map<string, FunctionUnit>();
  for (const h of base.hunks) {
    // 用「新文件行号」定位；删除型 hunk 用 oldStart
    const anchor = h.newLines === 0 ? h.oldStart : h.newStart;
    const owner = smallestEnclosingSymbol(symbols, anchor);
    const key = owner ? `${base.path}::${symbolPathOf(owner)}` : `${base.path}::<top-level>`;
    // 跨符号的大 hunk：退化为共同父符号，再退化到 <top-level>
  }
  return [...units.values()].sort((a, b) => a.range.startLine - b.range.startLine);
}
```

- 符号来源：`vscode.executeDocumentSymbolProvider`（首选）→ `web-tree-sitter`（无 LSP 语言）→ 缩进/正则启发式（兜底并在 UI 标注）。
- 返回值的两种形态都要兼容：`DocumentSymbol[]`（有 `children`/`range`）与 `SymbolInformation[]`（扁平 `location`）。
- **函数单元是「批量 Keep / Undo 的单位」，不是「写入的单位」**——写入是按文件一次完成的。这是与旧设计最本质的区别：粒度用于**审阅与回滚**，不再用于**拦截写入**。

### 11.3 面板长什么样

```
┌ Bee Code · 待审改动（3 个文件 / 7 个函数 / 11 个改动）──────────────┐
│ ☑ src/config/parse.ts               [全部 Keep]  [全部 Undo]      │
│   ▸ parseConfig()        4 处  +18 −6  [Keep] [Undo] [看差异] 低风险 │
│   ▸ ConfigParser.resolve() 1 处 +3 −1  [Keep] [Undo] [看差异] 中风险 │
│ ☐ src/config/parse.test.ts                                          │
│   ▸ 新增 3 个用例        2 处  +42 −0  [Keep] [Undo] [看差异] 低风险 │
│ ☑ src/index.ts                                                      │
│   ▸ main()（调用点变更）  4 处  +6 −6  [Keep] [Undo] 高风险 ⚠ 未联动 │
├─────────────────────────────────────────────────────────────────────┤
│ [全部 Keep ⌘⏎]  [全部 Undo]  [恢复到检查点…]  [导出 patch]            │
└─────────────────────────────────────────────────────────────────────┘
```

- 三档粒度（`beeCode.review.granularity`）：`function`（默认）/ `change`（单条 LineChange）/ `file`。
- 风险分级：删除行 > 30、触碰 `package.json` / CI / `*.config.*`、新增依赖、删除文件、修改测试 → `medium/high`。
- **关联组**：同一次签名变更跨多个文件时给横幅提示；若只 Keep 了一部分，标黄「调用点未全部更新」。
- 键盘：`A` Keep 当前、`R` Undo 当前、`Shift+A` 全部 Keep、`Shift+R` 全部 Undo、`Enter` 看差异、`Space` 展开。
- 状态栏常驻一个 `待审 7 处` 的入口，避免用户忘了还有没 Kept 的改动。

### 11.4 三个容易踩的边界

1. **只 Undo 一半 → 半截重构**。缓解：关联组提示 + Undo 后跑一次 `get_diagnostics`，把**新增**错误贴在卡片上（不阻塞，只提示）。
2. **Undo 一个新建文件**：文件从「有内容」回到「不存在」，实现上要 `deleteFile` 而不是写成空文件；反之 Undo 一次删除 → 用 `baseText` 重建。
3. **Undo 后原本的空文件 / 目录**：删除文件后如果目录空了，**不要**顺手删目录（用户可能靠它做结构约定）。

### 11.5 与 git 及工作区状态的关系

- Agent **不自动 commit**，提交权 100% 留给用户；可选「Keep 后自动 `git add`」（只 stage，方便 `git diff --cached` 复查）。
- 「导出 patch」把本轮所有 PendingEdit 序列化成标准 unified diff，便于在别处审视或应用。
- ⚠️ **不要承诺多文件原子性**：文件系统没有跨文件事务。可做到的只有「先在内存里把每个文件都算成功，再逐个写」，并如实报告哪几个成功。`git apply` 的默认原子性只覆盖**单个补丁内**。
- 会话结束时若仍有 `pending`：默认**保留为待审并提示**（不偷偷 Keep、也不偷偷 Undo），可配置为「自动 Keep」。

---

## 12. 安全与隐私

### 12.1 密钥

- 只存 `SecretStorage`，见 [§5.3](#53-密钥存储)。
- **传给内核时只走一次握手**：`apiKey` 通过 Python 子进程的 **stdin** 作为 `initialize` 参数传入，**不放 argv**（`ps` 全机可见）、**不放环境变量**（同用户可读、容易被 `env` 或崩溃转储带进日志）。内核只在内存持有，不落盘。
- 所有日志走 `redact()`：`/sk-[A-Za-z0-9_\-]{8,}/g`、`/Bearer\s+\S+/gi`、`/([?&](api_?key|token)=)[^&]+/gi`。
- 「导出诊断包」功能默认剔除：prompt 全文、文件内容、密钥、内网 URL。
- 明确声明：**扩展没有后端**，请求直达用户配置的 `base_url`；不接入任何遥测（或首次启动显式询问，默认关）。

### 12.2 工作区信任（Workspace Trust）

- 声明 `capabilities.untrustedWorkspaces.supported: "limited"`：受限模式下禁用 `run_command`/`run_test`，只读工具 + 写入待审仍可用，但写入门闸全部强制打开。
- 打开不受信任工作区时，在面板顶部显示警示条。

### 12.3 文件访问边界

- 所有路径 `path.resolve` 后必须 `startsWith(workspaceRoot)`，拒绝 `..` 穿越与符号链接逃逸。
- 默认拒绝写入：`.git/**`、`node_modules/**`、`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.beecode/secrets*`。
- 读取大文件截断（> 512KB 拒绝，> 100KB 只给大纲 + 片段）。
- 忽略规则三层合并：内置默认 → `.gitignore` → 用户 `beeCode.files.exclude`。

### 12.4 命令执行

- v1 默认 **不启用**。
- 启用后：命令 allowlist（`npm test`、`pytest`、`go build`…）+ 每次执行前弹确认（显示完整命令行、cwd、超时）+ 输出截断回填。
- 🧪 执行沙箱方案见 [§14.3](#143-沙箱四个层级越往下越真隔离) 与 [§10.8](#108-仍然不执行代码)——宿主机隔离（容器 / OS 沙箱）是「真隔离」与「假隔离」的分水岭。

---

## 13. Skill 与 MCP 集成

### 13.1 Skill（可复用的领域知识包）

```
.beecode/skills/<skill-name>/
├─ SKILL.md          # 必填：front-matter + 正文
├─ examples/         # 可选：few-shot 片段
└─ scripts/          # 可选：可被工具调用的小脚本
```

```markdown
---
name: react-form-refactor
description: 把受控表单重构为 react-hook-form + zod 校验
when_to_use: 用户要求迁移表单校验逻辑、或改造 Form 组件时
allowed_tools: [read_file, search_code, file_outline, apply_patch]
---

## 步骤
1. 找到所有 `<form>` / `useState` 驱动的字段...
## 代码约定
...
```

- **渐进式披露（progressive disclosure）**：提示词里只放 `name + description + when_to_use`（约 20~40 token/个）；模型判断需要时调 `load_skill(name)` 取正文。这样装 50 个技能也只花 ~1.5k token。这是 Claude Code 的 Agent Skills 采用的做法，也被 Continue 的 rules/custom commands 以近似方式使用。
- 技能的 `allowed_tools` 是**收窄**而非扩张：技能不能获得当前模式没有的工具。

### 13.2 MCP（Model Context Protocol）

- MCP = 客户端/服务器架构的开放协议（JSON-RPC 2.0），服务器通过 **tools / resources / prompts** 暴露能力。
- 传输：本地 `stdio`（子进程 stdin/stdout）、远程 **Streamable HTTP**、旧版 `SSE`。
- 本项目作为 **MCP Client**（因为要控制自己的 loop 与审批）：

```jsonc
// .beecode/mcp.json（与 VS Code 的 .vscode/mcp.json 结构对齐，便于互操作）
{
  "servers": {
    "github": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": { "GITHUB_TOKEN": "${secret:beeCode.mcp.github}" } },
    "postgres": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": {} }
  }
}
```

- 工具命名空间：`mcp__<server>__<tool>`，避免与内置工具撞名。
- **审批策略**：`readOnlyHint: true` 的 MCP 工具可直接执行；其余每次询问，且允许用户在会话内「本工具本次允许」。
- 启动失败必须优雅降级（服务器崩了不能让整个扩展崩）。
- 🔬 互操作加分项：同时用 `vscode.lm.registerMcpServerDefinitionProvider` + `contributes.mcpServerDefinitionProviders` 把同一份配置注册给 VS Code 原生 Chat，让用户在 Copilot Chat 里也能用到同一批 MCP 工具（VS Code 已内置完整 MCP 支持：tools/resources/prompts/elicitation/sampling/OAuth/roots）。

### 13.3 三者边界

| 机制 | 提供什么 | 谁执行 | 何时用 |
| --- | --- | --- | --- |
| 内置 Tool | 编辑器内能力（读写/检索/诊断/审批） | 扩展自身 | 永远可用 |
| Skill | 知识与流程（怎么做某类任务） | 模型按指令执行 | 有明确套路的任务 |
| MCP Server | 外部系统的能力（GitHub/DB/浏览器/内部服务） | 独立进程或远端服务 | 需要访问工作区之外 |

---

## 14. 工业界参考

> 这一节是「别人怎么做的」的横向对照，目的不是抄，而是**确认我们的每个设计都不是拍脑袋**。事实性描述基于各项目公开文档/源码（链接见 [§20](#20-参考资料)），具体实现会随版本变化。

### 14.1 七个项目的一张表

| 项目 | 形态 | 编辑怎么落地 | 执行隔离 | 上下文怎么找 | 循环/预算 | 记忆与规则 |
| --- | --- | --- | --- | --- | --- | --- |
| **Cline** | VS Code 扩展（宿主 ↔ Webview 分离） | 每次工具调用前审批（按 read/edit/command/browser/MCP 分类可自动批准）；编辑走 diff 卡片；**Checkpoints = 影子 git 仓库**，可 Compare / Restore | 扩展内**无 OS 沙箱**，边界是逐调用人工审批；命令风险由模型用 `requires_approval` 标注（不是固定白名单） | 文件提及 + 工具自主读取 + 自动截断 | 请求数/预算上限 + 随时打断；长命令 30s 提醒 | `.clinerules/`、根 `AGENTS.md`、`~/.agents/AGENTS.md` |
| **Continue.dev** | core（Node）+ 扩展 + GUI 三层 | **真实文件内的行内 diff**，逐 change 接受/拒绝（`Cmd+Opt+Y/N`，全部接受 `Cmd+Shift+Enter`） | 无执行 | 原 `@Codebase`（本地 embedding + 关键词 + rerank）**已弃用**，转向 agentic 探索 + rules + MCP | 单轮为主 | `rules` 每次都拼进 system（always-on 成本） |
| **Aider** | 终端 CLI | 直接改文件 + **每次改动自动 git commit**（可回滚） | 无（可 `--docker`） | **repo map**：tree-sitter 符号 + 依赖图 **graph ranking**，`--map-tokens` 默认 **1k** | 编辑失败重试 `max_reflections` 默认 **3**；`--auto-lint` 默认开 | `CONVENTIONS.md`、`.aider.conf.yml` |
| **Claude Code** | 终端 agent | **写前按权限确认**（无 hunk 级接受）；事后用 checkpoint + `/rewind` 回滚 | **最强 OS 沙箱**：macOS Seatbelt / Linux bwrap+socat（可选 seccomp）；写=cwd+临时目录，读=整机（含凭据文件），网络默认走本地代理且 `allowedDomains` 为空 | **agentic search**（glob/grep/read），无预建索引 | `max_turns` / `max_budget_usd`（默认不设限，超支最多一个响应）；压缩 thrashing 会主动报错；`Esc` 取消 | `CLAUDE.md`（建议 <200 行）、Skills、subagents、hooks |
| **Codex CLI** | 终端 CLI（Rust） | 结构化 `apply_patch` 工具 | **默认沙箱** + 审批策略正交：`sandbox_mode` = read-only / workspace-write / danger-full-access；Linux 用 Landlock（+bwrap 路径），Windows 有受限令牌沙箱 | 自主检索 | `approval_policy` = on-request / granular / never；`circuit_break_action` | `AGENTS.md`、`TrustLevel` |
| **OpenHands** | 服务化平台 | 在容器内直接改，改动进事件流 | **容器即执行环境**：`DockerWorkspace` 起 container 内 agent-server（对比 `LocalWorkspace` 无隔离） | 文件浏览 + 检索工具 | **StuckDetector**（滑窗模式匹配检测重复动作循环）+ 每步可中断 + `WAITING_FOR_CONFIRMATION` | 事件流持久化、会话状态可恢复 |
| **GitHub Copilot（VS Code）** | 原生集成 | **Working Set** + 逐个 inline change 的 **Keep / Undo**（或全部）；`chat.editing.autoAcceptDelay` 可延时自动接受 | 工具审批（敏感文件 glob 可强制审批，如 `.env`、`.vscode/*.json`） | `#` 上下文引用 + 内置检索 | 工具审批门 + 停止按钮 | `.github/copilot-instructions.md`、`AGENTS.md` |

### 14.2 Agent Loop 的三个流派

1. **单轮 tool-calling 循环**（Cline / Continue / Copilot / 本项目）
   `while (!done) { llm(messages, tools) → 执行 tool_calls → 回填 → }`，结束条件是「模型不再调用工具」或调用显式的 `attempt_completion`。
   优点：实现简单、可逐步展示、天然可中断；缺点：容易「走一步看一步」，长任务缺全局计划。
2. **计划-执行分离**（Aider 的 architect 模式、Claude Code 的 plan 模式）
   先用一个模型产出方案/待改文件名清单，再让另一个模型（或另一轮）按计划改。
   优点：长任务稳定性显著更好，token 花费可控；缺点：多一次往返，交互变重。
3. **事件驱动 / 状态机**（OpenHands）
   所有动作都是事件（`Action` / `Observation`），由 `EventStream` 串联，`State` 可序列化 → 天然支持「暂停/恢复/回放/多人观察」。
   优点：可观测性最好，适合做产品级审计；缺点：工程复杂度高。

**我们的选择**：以流派 1 为骨架（`AgentLoop` 已经是「事件 → 状态」的形式，向流派 3 靠），并在 Builder 模式对「涉及 ≥3 个文件」的任务自动插入一个 **Plan 阶段**（流派 2 的轻量版），计划以清单形式给用户看一眼再执行。另外吸收两个已验证的细节：**只读工具并发执行、写类工具串行执行**（Claude Code 的做法，既快又不打架）；**审批是循环的一等事件**而不是事后补丁（Codex 把 `approval_policy` 做成了协议字段）。

### 14.3 沙箱：四个层级，越往下越「真隔离」

```
L0 无隔离           直接写文件、直接跑命令              ← 只在可信环境可接受
L1 审批/回滚隔离     命令逐条确认；改文件有检查点可回滚    ← Cline（扩展内）、Copilot、本项目 v1（改文件侧）
L2 OS 级沙箱        写白名单 + 读黑名单 + 网络走代理     ← Claude Code：Seatbelt / bwrap+socat(+seccomp)
L3 容器/微虚拟机     Docker、gVisor、Firecracker          ← OpenHands（DockerWorkspace）；云端 agent 用 VM
```

**关键判断**（也是本项目最重要的一条安全结论）：**「改文件」和「执行代码」需要的隔离级别不同。**
- 改文件只需要 L1（可回滚 + 高风险写前门闸）。所以 Cline 的扩展版敢在没有 OS 沙箱的情况下工作：它的边界是「每个工具调用都要你点一次」；本项目的边界是「改动立即标记待审 + 影子 git 检查点」。
- 执行代码必须有 L2/L3。因为**审批是可以被「说服」的**：一次 prompt injection 就能让模型写出一条看起来无害的命令，而用户点了「同意」。Claude Code 的沙箱配置恰好说明了这个思路：即使模型被骗，内核层也只允许写 cwd 与临时目录、网络默认无直连。
- 一个诚实的边界说明：Claude Code 的**文件工具、MCP server、hooks、LSP 都跑在沙箱之外**，原生 Windows 下也不沙箱化。也就是说「有沙箱」不等于「所有路径都被沙箱覆盖」，读 README 的人应该知道这一点。

本项目 v1 只做 L1 且默认不执行命令，就是为了不在没有 L3 的情况下埋雷；`run_command` 一旦启用，必须同时具备 L2/L3，见 [§10.8](#108-仍然不执行代码)。

### 14.4 API Key 隐私：两条路线

| 路线 | 做法 | 代表 | 代价 |
| --- | --- | --- | --- |
| **本地持有** | key 存 OS 凭据库（VS Code `SecretStorage` → Electron `safeStorage` → Keychain/DPAPI/libsecret），请求从本机直连模型端点 | Cline（扩展内）、Claude Code（Keychain / 0600 文件 / 用户 ACL）、Codex（`keyring`/`file`/`ephemeral`）、本项目 | 用户自付账单；每家厂商要自己配 |
| **云端代管** | key 上传到服务端加密存储，请求经服务端代理；或干脆用订阅额度 | 商业订阅制产品、Cline 的托管额度、企业远程配置注入 org key | 需要信任服务端；有合规与泄露面 |

本项目的红线（写进 `SECURITY.md`）：**没有后端、没有中转、没有遥测**。所以能诚实地说「你的代码只发给你自己填的那个 URL」。可借鉴的工程细节：环境变量清洗（`*TOKEN*`/`*SECRET*`/`*KEY*`/`*AUTH*`）、URL 与错误信息里的凭据一律 `REDACTED`、日志用 `SecretStr`/`RedactedString` 包装（OpenHands 的 Secret Registry 是「内存态 + 打码日志」最干净的实现）。详见 [§12.1](#121-密钥)。

### 14.5 Skill 与 MCP：两种扩展方式的定位

- **MCP** 解决「**能力**」扩展：JSON-RPC 控制面，服务器暴露 **tools / resources / prompts**，客户端还要实现 sampling / roots / elicitation。传输是 `stdio`（本地子进程）与 **Streamable HTTP**（旧 `sse` 已弃用）。客户端流程：`tools/list` → 转成模型的 function schema → 调用前审批 → 结果回填。
- **命名空间**：`mcp__<server>__<tool>`（Claude Code 就是这个格式，本项目直接对齐；插件的嵌套 server 再加一层 `mcp__plugin_<plugin>_<server>__<tool>`）。**这不是审美问题**：不加前缀，两个 server 都提供 `search` 时模型会随机调一个，而且审批弹窗没法告诉用户「这是哪个 server 的能力」。
- **MCP 的真实难点是上下文成本**，不是协议。几十个工具、每个几百 token 的 schema，会直接把窗口吃掉。工业界的解法值得抄：**默认只注入名字 + 服务器说明，正文按需加载（tool search）**；**工具输出设硬上限**（Claude Code 是 25k token 上限、10k 开始告警、超过 50k 字符就落到临时文件并只给路径）；超大 HTTP body 直接失败。
- **Skill** 解决「**知识**」扩展：把「某类任务该怎么做」写成 Markdown，靠**渐进披露**控制成本。三层加载：`name + description` 常驻（每个约 100 token）、正文只在被使用时加载（Cline 建议 <5k token）、附带的脚本/文档只在被引用时读。Claude Code 的 Agent Skills 是这个模式最完整的实现（`description` 决定自动触发，`allowed-tools` 收窄权限，`context: fork` 让技能在子 agent 里跑）。
- 反例：把 `rules` **每次都拼进 system message**（Continue 的做法）实现简单，但装 20 条规则就是常驻的几千 token「上下文税」。本项目采用「规则短小常驻 + 长知识做成 skill」的组合。
- 两者互补：Skill 告诉模型「该按什么流程做」，MCP 告诉模型「能用什么工具做」，内置 Tool 提供「编辑器里必须做的事」（读写、diff、审批）。

### 14.6 防死循环：工业界的「五道闸」

| 闸 | 工业界的真实实现 |
| --- | --- |
| 步数/迭代上限 | Claude Code 的 `max_turns`（Agent SDK，**默认不设限**）、OpenHands 的迭代上限、Aider 的 `max_reflections`（默认 3） |
| 预算上限 | Claude Code 的 `max_budget_usd`；诚实的坑：预算在**响应返回后**才结算，因此可能超支「一个响应 + 仍在跑的子 agent」 |
| 重复/无进展检测 | OpenHands 的 **StuckDetector**（对事件流做滑窗模式匹配，识别「重复同一动作循环」）；Claude Code 的**压缩 thrashing 检测**（压缩后一个超大文件立刻又把窗口填满 → 主动报错而不是无限压缩） |
| 熔断 | Codex 的 `circuit_break_action`（`default` / `strict`）用结构化错误中断 |
| 人工闸门 | Cline / Copilot 的逐工具审批；Codex 的 `approval_policy`；Claude Code 的权限模式（deny → ask → allow 的优先级） |

外加一个经常被忽略的：**可取消性**。所有 I/O（LLM 请求、工具执行）都必须接 `AbortSignal`，否则「停止」按钮只是摆设。Claude Code 的 `Esc` 能取消**正在执行的工具调用**，而不只是停止生成，这是合格线。

还有一个反直觉的经验：**上限不要「一撞就死」**。先把「你重复了同一个调用」作为一条系统提示注入，往往能自愈；连续多次再硬停。本项目 [§7.3](#73-循环守卫防死循环--防烧钱) 的阈值就是这么定的。

### 14.7 上下文记忆：三种检索流派与三种记忆层次

**检索流派**：

| 流派 | 做法 | 优点 | 缺点 | 代表 | 现状 |
| --- | --- | --- | --- | --- | --- |
| agentic search | 给模型 grep/glob/read 工具，让它自己找 | 无需索引、永远最新、可解释 | 多轮往返、依赖模型规划能力 | Claude Code、Codex CLI、Cline | **主流** |
| 结构索引 | tree-sitter 抽符号 + 依赖图排序 → 压成 repo map | token 效率极高、跨文件任务强 | 需要语言支持、图构建有成本 | Aider（`--map-tokens` 默认 1k，无文件时 ×2） | 稳定有效 |
| 向量索引 | 全库 embedding + 相似度召回 | 语义召回强 | 索引陈旧、成本、隐私面 | Continue 原 `@Codebase` | **已弃用** |

最后一行是最有信息量的：Continue 的 `@Codebase` 曾经是「本地 embedding + 关键词 + LLM rerank（25 召回 → 重排 → 5 条入上下文）」的标杆实现，但**现在已被官方标记为 deprecated，转向 agentic 探索 + MCP（如 DeepWiki/Context7）补充库外知识**。这让本项目「默认不上向量索引」的取舍有了直接依据，而不是偷懒。

**压缩（compaction）**：主流做法都是「**先清工具输出，再摘要历史**」——因为工具输出（大文件、长日志）通常占了窗口的一半以上，且复用价值最低。代价是压缩是有损的：Claude Code 在压缩后要**重新注入** system prompt、项目记忆、计划、以及「最近修改的 5 个文件」，技能正文按 5k/技能、25k 总量重新注入。这条经验直接对应本项目的 [§8.4](#84-压缩与记忆)。

**记忆层次**：工作记忆（当前 messages）→ 压缩摘要（会话级）→ 长期项目记忆（`AGENTS.md` / `CLAUDE.md` / `.clinerules` / `.cursor/rules` 这类**跟着 git 走**的规则文件）。跨工具正在收敛：Claude Code 在没有 `CLAUDE.md` 时会读 `AGENTS.md`，`/init` 还能导入 `.cursor/rules`、`.clinerules`、`.github/copilot-instructions.md`。本项目因此**优先读 `AGENTS.md`**，`.beecode/rules/` 作为补充。

### 14.8 我们直接采纳的六个决定

1. **改动即时写入 + 即时审阅**（`Keep` / `Undo` + 检查点），这是 Copilot / Cursor / Cline / Continue 的共同范式；本项目只在此基础上把分组粒度做到函数级。
2. **默认不执行命令**，一旦执行必须沙箱化（Codex / Claude Code / OpenHands 的教训）。
3. **无后端、key 本地**（开源阵营的共识），用 `SecretStorage` 而不是 `settings.json`。
4. **agentic search 优先，向量索引不做**（Claude Code 的做法 + Continue 弃用 embedding 的旁证）。
5. **MCP 做能力、Skill 做知识、内置工具做编辑器**，且 MCP 工具名加 `mcp__<server>__` 前缀。
6. **只读工具并发、写工具串行、审批是一等事件**（Claude Code 与 Codex 的结构性做法）。

### 14.9 我们与工业界的唯一差异：分组粒度

| 维度 | 工业常见 | 本项目 |
| --- | --- | --- |
| 写入时机 | 先写盘、再 `Keep`/`Undo` | **相同**（v0.1 起改为一致） |
| 回滚底座 | Cline 影子 git / Claude Code checkpoint + `/rewind` | **相同**：影子 git + Restore 三档 |
| 审阅粒度 | 按文件 / 按单条 `LineChange` | **按函数**归并 hunk；函数内默认联动，跨文件签名变更给「关联组」警告 |
| 写入门闸 | 敏感文件 glob 强制审批 | **相同思路** + 大批量写前确认（>5 文件或 >300 行） |

一句话：**范式随大流，粒度做细。** 唯一自己加的东西是「函数级分组 + 关联组提示」，因为它直接对应用户的心智模型（「我要不要这个函数的新实现」），而不是「我要不要第 3 个 hunk」。

### 14.10 为什么最终改用主流范式（先写后审）

调研里最反直觉的一条：VS Code 官方对「待审改动」的定义是**事后确认**，不是事前拦截。

> Pending means that you can keep or undo the **saved** edit. It doesn't mean that the edit is waiting to be written to disk.

词表也印证：`Keep` 是承认一个**已经发生**的写入，`Save` 才是执行写入。所以 Copilot/Cursor 是 `Keep`/`Undo`，Cline 用影子 git 的 `Compare`/`Restore` 兜底，Claude Code 只做「写前按权限询问」+ `/rewind`。**早先的 Overlay 设计（先审后写）是少数派**，v0.1 决定改回主流。

| 推翻 Overlay 的理由 | 具体代价 |
| --- | --- |
| 与编辑器生态割裂 | 自建虚拟文档、自建预览、自建 undo，用户 `Ctrl+Z` 撤不掉「AI 的提案」，还得学一套新交互 |
| 预览成本翻倍 | 红绿 + 多文件总览 + 逐改动回退全要自己做；而走写盘后，SCM QuickDiff 直接白送这三样 |
| 崩溃即丢失 | 提案只在内存里，扩展一挂全没；写盘 + 检查点至少「东西还在，能回滚」 |
| 与用户已有编辑冲突 | Overlay 里的「基线」与用户正在编辑的文档是两套状态，容易互相打架；写盘后一切以 `TextDocument` 为准，冲突检测天然统一 |
| 生态互操作 | 写盘后，格式化、lint、git diff、外部工具、其他扩展看到的都是同一份真实内容 |

**代价也认了**：磁盘会短暂处于「未 Keep」状态；必须靠 `PendingEdit` 记录 + 检查点保证可回滚；扩展异常退出时以检查点为准。这三条已经写进 [§10.5](#105-检查点checkpoint回滚的地基) 与 [§10.6](#106-冲突与并发)。

**从 Overlay 保留下来的一件事**：写入门闸（[§10.7](#107-写入门闸guardrails)）——敏感文件、超大批量、删除操作仍然先问。这不是范式妥协，而是「把事前拦截用在该用的地方」：**低风险改动即时写，高风险改动才拦**。

### 14.11 值得抄进代码里的具体数字

| 参数 | 参考值 | 出处 |
| --- | --- | --- |
| 代码压缩触发点 | 窗口的 65%（Codex 后台压缩）~ 80%（本项目） | Codex 配置 |
| Claude Code 自动压缩阈值 | 1M 模型约在 967K；未知模型 ID 按 200K 处理 | Claude Code 文档 |
| 压缩后重注入 | 最近修改的 5 个文件；技能正文 5k/个、25k 总量 | Claude Code 文档 |
| 项目记忆文件建议长度 | `CLAUDE.md` < 200 行；自动记忆 `MEMORY.md` 只读前 200 行 / 25KB | Claude Code 文档 |
| MCP 工具输出上限 | 25k token（10k 告警，>50k 字符落盘只给路径） | Claude Code 文档 |
| repo map 预算 | `--map-tokens` 默认 1k，无文件入上下文时 ×2 | Aider 文档 |
| 技能元数据成本 | ~100 token / 技能，正文 < 5k token | Cline 文档 |
| 编辑失败重试 | Aider `max_reflections` = 3 | Aider 源码 |

---

## 15. 目录结构

✅ = 已实现（v0.0.1 壳骨架）　⬜ = 待实现

```
bee-code/
├─ package.json                  # ✅ 扩展清单：11 个命令 / 3 个快捷键 / 菜单 / 视图 / 15 项配置
├─ tsconfig.json                 # ✅ 扩展侧：lib 无 DOM、strict、verbatimModuleSyntax、module=preserve
├─ tsconfig.webview.json         # ✅ 前端侧：lib 含 DOM、allowJs+checkJs、不含 node/vscode 类型
├─ esbuild.mjs                   # ✅ 打包 → dist/extension.js（cjs，vscode 保持 external）
├─ .vscodeignore                 # ✅ vsce 打包排除规则
├─ .vscode/                      # ✅ launch.json（Extension + debugpy attach）、tasks.json
├─ .gitignore / .gitattributes   # ✅（本地 .vscode/settings.json 已忽略）
├─ README.md / LICENSE (MIT)     # ✅
├─ pyproject.toml                # ✅ 内核工程定义（hatchling，httpx + pydantic）
├─ docs/                         # ⬜ architecture / ipc / prompts / change-review / adr
├─ src/                          # ★ TS 薄壳：唯一允许 import 'vscode' 的地方
│  ├─ extension.ts               # ✅ 装配根：内核生命周期、通知路由、命令依赖
│  ├─ coreApi.ts                 # ✅ 内核抽象（PythonCore / MockCore 共用接口）
│  ├─ protocol.ts                # ✅ 协议类型 + 方法名 + NDJSON 分帧（LineReader）
│  ├─ config.ts                  # ✅ 设置读取、${workspaceFolder} 解析、会话 id
│  ├─ paths.ts                   # ✅ 路径策略（越界 / 敏感文件 / 禁止目录）
│  ├─ log.ts                     # ✅ OutputChannel + 脱敏（密钥永不落日志）
│  ├─ rpc/
│  │  ├─ client.ts               # ✅ 起子进程、握手、请求/响应、取消、崩溃处理
│  │  └─ server.ts               # ✅ 内核 → 壳的方法路由（11 个）
│  ├─ adapters/
│  │  ├─ fsAdapter.ts            # ✅ fs.read / fs.list（.gitignore 合并、大小上限）
│  │  ├─ searchAdapter.ts        # ✅ search.grep（公开 API 实现，见下方说明）
│  │  ├─ symbolsAdapter.ts       # ✅ symbols.outline（DocumentSymbol / SymbolInformation 双兼容）
│  │  ├─ diagnosticsAdapter.ts   # ✅ diagnostics.get
│  │  ├─ editAdapter.ts          # ✅ edit.apply（WorkspaceEdit、版本冲突检测、write/delete）
│  │  ├─ diffAdapter.ts          # ✅ diff.open（虚拟文档 + vscode.diff，另含 vscode.changes）
│  │  ├─ checkpointAdapter.ts    # ✅ checkpoint.create / restore（影子 git）
│  │  └─ interactionAdapter.ts   # ✅ secrets.get + confirm.ask（写入门闸）
│  ├─ panel/
│  │  └─ chatViewProvider.ts     # ✅ WebviewView 宿主：CSP、消息白名单、状态推送
│  ├─ commands/
│  │  └─ register.ts             # ✅ 命令注册 + 选区采集（多光标、上下文外扩 2 行）
│  └─ dev/
│     └─ mockCore.ts             # ✅ 假内核：不装 Python 也能调壳（流式/pending/取消）
├─ media/                        # ✅ 面板前端（无构建步骤：原生 JS + CSS，跟随主题变量）
│  ├─ panel.js / panel.css       #    panel.js 由 tsconfig.webview.json 做 JSDoc 类型检查
│  ├─ vscode-webview.d.ts        #    acquireVsCodeApi 声明（DOM lib 里没有）
│  └─ icon.svg
├─ beecode/                      # ★ Python 内核（骨架已就位，业务待实现）
│  ├─ __main__.py                # ✅ 入口 + 方法注册；⬜ chat.send / review.* / abort
│  ├─ ipc.py                     # ✅ JSON-RPC 对端：分发、超时、$·cancelRequest、BOM 容错
│  ├─ shell.py                   # ✅ ShellClient：fs/search/edit/checkpoint/diff/confirm 的类型化封装
│  ├─ loop/ modes/ prompts/      # ⬜ AgentLoop、模式、提示词
│  ├─ llm/ context/ tools/       # ⬜ OpenAI 客户端、检索编排、工具
│  ├─ apply/ pending/ guard/     # ⬜ 补丁解析、待审状态机、预算守卫
│  └─ mcp/ skills/               # ⬜ MCP 客户端、Skill 加载
├─ tests/                        # ⬜ python/ (pytest) + shell/ (@vscode/test-electron)
├─ scripts/                      # ⬜ bootstrap.py（找 Python/建 venv）+ build_sidecar.py（PyInstaller）
└─ .github/workflows/            # ⬜ ci.yml / release.yml
```

### 15.1 三个实现取舍（值得知道）

1. **`search.grep` 没用 `findTextInFiles`**：它至今是 proposed API（stable `@types/vscode` 里没有）。当前实现是 `findFiles` + 逐文件读 + 正则匹配，上限 4000 文件 / 256KB，能用的同时保证只用公开 API。🔬 后续可以探测系统 `rg`，有则 spawn `rg --json`。
2. **面板前端没有构建步骤**：`media/panel.js` 是原生 JS（约 200 行），刻意不引入 Vite/React —— 壳阶段的目标是「F5 就能跑」。等 UI 复杂到需要组件化时再换，`chatViewProvider` 的 postMessage 契约不用动。但它是**被类型检查的**：`tsconfig.webview.json` 用 `allowJs + checkJs` + JSDoc 跑 `tsc -p`，所以面板里的空引用、拼错属性照样会报错。
3. **两个 tsconfig 是刻意分开的**：扩展侧 `lib` 不含 `DOM`（宿主里没有 `document`，给了类型就会写出运行时报错的代码）；前端侧反过来，`lib` 含 `DOM`、`types` 为空（webview 里没有 Node 和 `vscode`）。`npm run typecheck` 会依次跑两个项目。


---

## 16. 路线图

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M0 双进程骨架** | TS 壳（命令 / 面板 / SecretStorage）+ Python 子进程 + RPC 握手 + 模型配置向导 + 单轮对话 | 填 DeepSeek/Ollama 端点后能流式一问一答；协议版本不匹配时有可读报错 |
| **M0.5 可分发** | `bootstrap.py`（uv / venv 自举）+ PyInstaller sidecar + 三平台 vsix | 干净机器装上 vsix 即可用，不需要用户手工装 Python |
| **M1 只读 Agent** | Agent Loop、只读工具（经 RPC 读盘）、文件清单、检索、Chat 模式、选区快捷键 | Chat 模式能自主读 3~5 个文件后准确回答带行号的解释 |
| **M2 写入与待审** | `apply_patch` + `WorkspaceEdit` 写入、`PendingEdit` 记录、影子 git 检查点、QuickDiff 红绿、逐函数 Keep/Undo | Builder 改 3 个文件后能逐函数 Keep/Undo；全部 Keep 后 typecheck 通过；`Restore` 能整轮回到改前 |
| **M3 Debugger** | 诊断接入、Debugger 提示词、验证回路（可选 run_test） | 给一个真 bug，能定位到正确函数并给出最小补丁 |
| **M4 扩展生态** | Skill 加载、MCP 客户端、压缩与记忆、成本面板 | 挂 3 个 MCP server + 10 个 skill，会话稳定不爆 token |
| **M5 发布** | vsce 打包、CI、Marketplace 上架、GitHub Release | `code --install-extension bee-code-x.y.z.vsix` 可用 |

> **当前进度（v0.0.1）**：M0 的**壳侧已完成**（`tsc --noEmit` 通过、`dist/extension.js` 构建成功、11 个 RPC 方法注册完毕、面板/命令/检查点/QuickDiff 预埋都在）。
> 内核侧只有协议骨架：`initialize` / `shutdown` / `model.reload` 可用，`chat.send` 与 `review.*` 待实现 —— 也就是接下来 AI 逻辑的入口。

---

## 17. 开发与构建

双运行时：**Node.js 20+（壳）** + **Python 3.11+（内核）**。两边独立测试，靠 RPC 联调。

**本机开发环境（已就绪）**：Python 内核跑在 conda 环境 `beeagent`（Python 3.11.17，解释器 `D:\APP\conda\envs\beeagent\python.exe`）。激活：`conda activate beeagent`。

扩展通过三个设置项找到它，本机值写在 `.vscode/settings.json`（**已 gitignore，不进仓库**）：

```jsonc
{
  "beeCode.core.mode": "python",                                       // python | mock（mock 用内置假内核，便于只调壳）
  "beeCode.core.pythonPath": "D:\\APP\\conda\\envs\\beeagent\\python.exe",
  "beeCode.core.cwd": "${workspaceFolder}"
}
```

别人克隆后不配置也能跑：`pythonPath` 默认是 `python`（走 PATH），内核用 `pip install -e .` 装依赖即可。

**TypeScript 固定在 `6.0.3`**（= 当前 VS Code 内置版本），刻意不写 `^`：写 `^` 时下次 `npm install` 会装到 6.x 的更高小版本，于是又回到「本地绿、编辑器红」。查看你所用 VS Code 的版本：

```powershell
(Get-Content "<VS Code 安装目录>\resources\app\extensions\node_modules\typescript\package.json" -Raw | ConvertFrom-Json).version
```

```bash
# 1) 壳（Node 20+）
npm install
npm run watch              # esbuild --watch → dist/extension.js（vscode 保持 external）
npm run typecheck          # tsc --noEmit（strict）
npm run build              # 生产构建

# 2) 内核依赖（conda 环境已就绪，见上）
conda activate beeagent
pip install -e ".[dev]"    # httpx / pydantic / pytest；不加 -e 也能 `python -m beecode`

# 3) 只调壳、不碰内核
#    设置 beeCode.core.mode = "mock" → 内置假内核（流式、pending、取消都能验）

# 4) 冒烟测协议（不需要 VS Code）
#    往 stdin 喂 NDJSON，检查 stdout 的响应：
#      {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
#      {"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}

# 5) 跑扩展
#    在 VS Code 里打开本仓库 → F5 →「Run Extension (beeagent)」
#    launch.json 两个配置：① Extension（壳，Node 调试） ② Python: Attach（内核，:5679）

# 6) 质量与打包
pytest -q                                  # 内核单测（无编辑器，可 CI 直跑）
npx @vscode/vsce package                   # 生成 .vsix
```

### 17.1 Python 运行时分发（这是 A 方案最大的成本，必须早定）

| 方案 | 优点 | 缺点 | 建议 |
| --- | --- | --- | --- |
| **要求用户自带 Python** | 零打包成本 | 用户认知负担最大，「AI 插件为什么要 Python」 | ❌ 不单独用 |
| **PyInstaller 单文件 sidecar** | 用户零依赖；启动 ~200ms | 每平台 15–40MB；杀毒误报；需签名；`--target` 发多个 vsix | ✅ 发布主路径 |
| **首次运行 `uv` 自举 venv** | 体积小、依赖可更新 | 需要网络；企业代理/离线环境会卡 | ✅ 作为 fallback（sidecar 启动失败时） |
| **随包发 Python 运行时** | 完全可控 | 体积 + 许可合规成本最高 | 🧪 不推荐 |

落地建议：**sidecar 优先，失败回落 `bootstrap.py`（uv → venv → pip 三级降级），再失败给一条可复制的安装命令**。manifest 里 `extensionKind: ["workspace"]`，保证 Remote-SSH / 容器 / Codespaces 时内核跑在文件所在那一侧。

```jsonc
"extensionKind": ["workspace"],
"main": "./dist/extension.js"     // 没有 browser 入口：Python 内核不支持 Web 扩展
```

> 也就是说：**放弃 vscode.dev / github.dev**，这是 A 方案的确定代价。

`package.json` 关键字段（草案）：

```jsonc
{
  "name": "bee-code",
  "displayName": "Bee Code",
  "publisher": "<publisher>",
  "version": "0.0.1",
  "license": "MIT",
  "engines": { "vscode": "^1.104.0" },
  "extensionKind": ["workspace"],                // 内核要在文件所在那一侧启动
  "categories": ["Programming Languages", "Machine Learning", "Other"],
  "main": "./dist/extension.js",
  "activationEvents": [],                        // 1.74+ 由 contributes 隐式激活
  "contributes": {
    "commands": [
      { "command": "beeCode.chat.ask",       "title": "Bee Code: 提问（Chat）" },
      { "command": "beeCode.selection.chat", "title": "Bee Code: 解释选中代码" },
      { "command": "beeCode.selection.build","title": "Bee Code: 按选中代码生成改动" },
      { "command": "beeCode.selection.debug","title": "Bee Code: 排查选中代码" },
      { "command": "beeCode.files.pick",     "title": "Bee Code: 选择要阅读的文件" },
      { "command": "beeCode.model.configure","title": "Bee Code: 配置模型（base_url / key / model）" },
      { "command": "beeCode.review.keepAll",  "title": "Bee Code: 全部 Keep" },
      { "command": "beeCode.review.undoAll",  "title": "Bee Code: 全部 Undo" },
      { "command": "beeCode.checkpoint.restore","title": "Bee Code: 恢复到检查点…" }
    ],
    "keybindings": [
      { "command": "beeCode.selection.chat",  "key": "ctrl+alt+k", "mac": "cmd+alt+k", "when": "editorHasSelection" },
      { "command": "beeCode.selection.build", "key": "ctrl+alt+b", "mac": "cmd+alt+b", "when": "editorHasSelection" },
      { "command": "beeCode.selection.debug", "key": "ctrl+alt+d", "mac": "cmd+alt+d", "when": "editorHasSelection" }
    ],
    "menus": {
      "editor/context": [
        { "command": "beeCode.selection.chat",  "when": "editorHasSelection", "group": "beeCode@1" },
        { "command": "beeCode.selection.build", "when": "editorHasSelection", "group": "beeCode@2" },
        { "command": "beeCode.selection.debug", "when": "editorHasSelection", "group": "beeCode@3" }
      ]
    },
    "viewsContainers": {
      "activitybar": [{ "id": "beeCode", "title": "Bee Code", "icon": "media/icon.svg" }]
    },
    "views": {
      "beeCode": [{ "id": "beeCode.chatView", "name": "Agent", "type": "webview" }]
    },
    "configuration": { "title": "Bee Code", "properties": { /* §5.2 */ } }
  }
}
```

---

## 18. Git 与 GitHub 工作流

### 18.1 初始化（本仓库当前状态：已 `git init`，无 remote）

```bash
git init -b main                 # 已完成
git add .
git commit -m "docs: 初始 README 与总体架构"
git remote add origin git@github.com:<you>/bee-code.git
git push -u origin main
```

### 18.2 分支与提交

- 分支：`main`（可发布）← `feat/*`、`fix/*`、`docs/*`、`refactor/*`；发布用 `release/x.y.z` 打 tag。
- 提交信息遵循 **Conventional Commits**：`feat(loop): 支持并行 tool_calls`、`fix(pending): 修正 hunk 偏移`、`docs(readme): 补充 Keep/Undo 流程`。
- 一次提交只做一件事；提示词改动单独提交（`docs(prompts): 收紧 builder 输出契约`），便于回溯「哪次改提示词导致了效果退化」。

### 18.3 版本与发布

- SemVer：`0.x` 阶段允许破坏性变更，但必须在 `CHANGELOG.md` 标注 **BREAKING**。
- 发布链路：`git tag v0.1.0` → CI 构建 `.vsix` → GitHub Release 附 `.vsix` → `vsce publish`。
- Marketplace 发布需要一个 Azure DevOps PAT（`Marketplace > Manage` 权限）与在 `publisher` 下注册的扩展名；`README.md` 会作为详情页正文渲染，因此**本文件同时就是商店页**。

### 18.4 开源协作常规件

`LICENSE`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`（披露渠道与「密钥泄露如何处理」）、`.github/ISSUE_TEMPLATE/*`、`Dependabot`。

---

## 19. 许可与致谢

- 许可证：**MIT**（最宽松、生态最通用；任何人都可以自由使用、修改、再分发、商用，只需保留版权声明与许可声明）。随仓库的 `LICENSE` 文件为准。
- 致谢（设计上借鉴的开源项目）：Cline、Continue.dev、Aider、OpenHands、以及 VS Code 官方扩展样例。具体借鉴点见 [§14](#14-工业界参考)。

---

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

（具体机制对照见 [§14](#14-工业界参考)。）

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
