# Bee Code 架构设计

> 本文是 [README](../README.md) 拆出的详细设计文档：目标、分层、三模式、模型接入、Agent 循环、上下文工程、改动落地、工业界对照。
> 章节编号保持与 README 早期版本一致，内部锚点（如 §4.5、§10.6）在同一文件内可直接跳转。

## 0. 文档说明

- 本文档描述 **v0.0.x 设计阶段** 的总体架构，会随实现持续修订；接口以代码为准，本文以「为什么这样设计」为准。
- 标记约定：🧭 已定方案 ｜ 🔬 需在实现期验证（PoC） ｜ 🧪 实验性/可选。
- 本文档同时是一份**调研结论文档**：每个关键设计点都尽量给出对应工业界做法与出处（见 [§14](#14-工业界参考) 与 [§20 参考资料](./reference.md#20-参考资料)）。
- 项目定名 **Bee Code**：仓库名 `bee-code`，扩展 ID `<publisher>.bee-code`，显示名 `Bee Code`，命令前缀 `beeCode.`，配置项命名空间 `beeCode.*`，项目内数据目录 `.beecode/`，虚拟文档 scheme `beecode-xzyk520-base:`（带 publisher 前缀，避免与其他扩展撞名）。
- 修订：**v0.3 起，改动落地采用「提案（虚拟文件）→ 逐文件审批 → 落盘」**：内核给出的修正内容先当虚拟文件预览，用户接受才写盘。理由见 [§14.10](#1410-为什么最终采用逐文件审批提案模式)，方案见 [§10](#10-改动落地提案--逐文件审批proposal-then-apply)。
- 技术栈（v0.2 定）：**Python 内核 + TypeScript 薄壳**。VS Code 扩展 API 只有 TS/JS（Extension Host 是 Node.js），Python 无法作为扩展语言；因此把 agent 逻辑（循环/检索/提示词/补丁/协议）全部放进 Python 子进程，TS 壳只做编辑器集成。契约见 [§4.5](#45-壳--内核的-ipc-契约json-rpc-20-over-stdio)，分发方案见 [§17.1](./development.md#171-python-运行时分发这是-a-方案最大的成本必须早定)。
- 许可证：**MIT**（见 [LICENSE](../LICENSE)）。

---

## 1. 项目定位

### 1.1 一句话

把「一个能读懂你整个工程、能解释、能写、能修的 AI 结对程序员」装进 VS Code，并且**模型完全由用户自带**、**改动永远先给你看**。

### 1.2 要解决的问题

| 痛点 | 本项目的回答 |
| --- | --- |
| 云端订阅模型的绑定：只能用厂商自带的模型/订阅 | 用户自己填 `model` / `api_key` / `base_url`，任意 OpenAI 兼容端点（官方、DeepSeek、Qwen、Kimi、GLM、OpenRouter、Ollama、vLLM、one-api 网关…） |
| 一个模型提示词打天下：解释、生成、修 bug 用同一套 prompt，效果都不极致 | 三模式独立提示词 + 独立工具集 + 独立的「允许做什么」约束 |
| AI 直接改文件，改坏了才发现 | 改动先做成**虚拟文件提案**：源文件在"接受"之前一字不改；整轮还能 `Restore` 回滚 |
| AI 看不到「跟你这个问题相关」的代码 | 三级检索：文件清单 → 关键词/符号检索 → 工具驱动的按需精读 |
| 想改一段代码要先复制粘贴到聊天框 | 选中即问：右键 / 快捷键直接进 Chat、Builder、Debugger |
| 不知道 AI 到底动了哪些文件 | 每个文件一张提案卡片，左红右绿对照 + 一句话说明；逐个接受/拒绝，或一键全部 |

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
| **Proposal（提案 / 虚拟文件）** | 内核给出的"修正后的完整文件内容"，接受前只存在于内存；元数据经 `proposal.changed` 广播，正文按需 `proposal.read` 拉取 |
| **Checkpoint（检查点）** | 影子 git 仓库里的一次快照，用于 `Restore` 整轮回滚 |
| **Accept / Reject** | 审阅动词：`Accept` 把提案写进源文件（唯一写入时机），`Reject` 丢弃提案且磁盘零改动 |
| **Hunk（变更块）** | 统一 diff 中一个 `@@ ... @@` 块，diff 编辑器渲染的最小单元 |
| **Function Unit（函数单元）** | 把若干 hunk 归并到所属函数/方法的**可选**分组（扩展点，当前未启用；见 §11.4） |
| **Context Budget（上下文预算）** | 按比例分配给系统提示词、检索、历史、输出的 token 配额 |

---

## 4. 总体架构

### 4.1 分层

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L1  UI 层（VS Code 原生 + Webview）                                       │
│  Chat/Agent 面板 · 选区右键菜单 · 快捷键 · 文件选择器(QuickPick/Tree)      │
│  提案卡片（逐文件）· diff 预览 · 检查点 · 状态栏(token/费用/停止)        │
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
         ├─ L3 Proposal：算出修正后的全文，暂存为虚拟文件，`proposal.changed` 广播元数据
         ├─ 用户点「接受」→ 壳 `proposal.read` 拉正文 → `edit.apply` 落盘 → `proposal.decide(accept)`
         ├─ L2 渲染: QuickDiff 红绿长在真实文件上；面板按 文件→函数→改动 列表
         └─ 也可「全部接受 / 全部拒绝」；已接受的改动仍可 `checkpoint.restore` 整体回滚
                └─ 拒绝 → 不发 `edit.apply`；Restore → RPC `checkpoint.restore`
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
| `beecode/proposals` | L3 | 提案存储（虚拟文件正文）、接受/拒绝状态机 | 不直接调 git、不写盘 |
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
| 日志与排障 | `window.createOutputChannel('Bee Code')` + `… · 内核 stderr`（两个 channel，写入前统一 `redact()`；诊断包见 [§12.1.1](#1211-日志脱敏与诊断包已实现)） |
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
| `fs.read` | `path, startLine?, endLine?` | `{ text, version?, totalLines?, startLine, endLine, truncated }` | 优先用编辑器里的**未保存**内容 |
| `fs.list` | `glob, exclude?, maxResults?` | `{ paths[], truncated }` | 先多取再过滤（避免被忽略文件吃满配额）；壳合并 `files.exclude` + `.gitignore` |
| `search.grep` | `query, regex?, glob?, contextLines?, maxResults?, filesOnly?` | `{ hits[], files?, truncated }` | 壳内逐文件正则；`filesOnly` 只回文件+计数（召回阶段省 token） |
| `symbols.outline` | `path` | `{ symbols[], source }`；每个符号带 `range`（含注释）与 `selection`（标识符精确位置） | `executeDocumentSymbolProvider` |
| `symbols.search` | `query, maxResults?` | `{ symbols[], source: lsp\\|fallback\\|none, truncated }` | `executeWorkspaceSymbolProvider`（结果过滤工作区外/依赖）；无 provider 时「按名字粗筛文件 + outline」兜底 |
| `symbols.references` | `path, line, column?, maxResults?` | `{ locations[], truncated }` | `executeReferenceProvider`；**line 要用 `selection.startLine`**（用 range 起始行会落在注释里） |
| `diagnostics.get` | `path?` / `minSeverity?` / `maxItems?`（默认 200，上限 2000）/ `includeIgnored?` | `{ items[], total, truncated }`；每条含 `code`（`TS2322` 等）与 1-based 行列 | `languages.getDiagnostics`，按严重度排序、默认过滤 `node_modules`/`.git`/`.gitignore` |
| `edit.apply` | `path` / `newText` / `op?`（`write`\|`delete`）/ `expectedVersion?` / `reason?` | `{ applied, version?, conflict?, message? }` | **唯一写入通道**：单次 `WorkspaceEdit`（新建走 `createFile` + `insert`，换行符跟随目标文件） |
| `checkpoint.create` | `label?` / `paths?` | `{ id, files, skipped?, reason? }` | 影子 git 快照（`paths` 为轻量模式） |
| `checkpoint.restore` | `id` | `{ restored[] }` | 只恢复文件；任务/会话状态由内核合成 |
| `diff.open` | `path, baseText` | `{}` | 打开 `vscode.diff` 对照 |
| `confirm.ask` | `question, detail?, options[], rememberKey?` | `{ choice }` | 写入门闸用它问人；`detail` 会显示在选项下方 |
| `secrets.get` | `key` | `{ value }` | 只在会话启动时取一次，不进日志 |

#### 4.5.2 壳 → 内核（用户动作）

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| `initialize` | `protocolVersion, workspaceRoots[], modelConfig, hasKey` | 握手；版本不匹配直接失败并给可读原因 |
| `chat.send` | `sessionId, mode, text, attachments[]` | 发起一轮（`attachments` = 选区/文件引用） |
| `proposal.read` | `id` | 拉取提案正文（虚拟文件内容） |
| `proposal.decide` | `id, decision` | 壳落盘/丢弃**之后**告知内核 |
| `session.abort` | `sessionId` | 取消（同时 cancel 所有在飞的 RPC） |
| `model.reload` | `modelConfig` | 用户改了配置 |

#### 4.5.3 通知（无 id，单向）

- `ui.delta` `{ sessionId, text }` —— 流式文本，逐块推给面板。
- `ui.tool` `{ sessionId, name, args, status }` —— 工具开始/结束。
- `ui.usage` `{ inputTokens, outputTokens, costUsd }`。
- `proposal.changed` `{ added[], updated[], removed[] }` —— 只有元数据；壳据此刷新卡片，正文用 `proposal.read` 按需拉取。
- `log` `{ level, msg, fields }` —— 壳写进 OutputChannel（先过脱敏）。

#### 4.5.4 五条工程约定

1. **取消要能穿透**：`$/cancelRequest` 风格（带被取消的 `id`），内核收到后 `AbortSignal` 中断 HTTP 请求与工具；壳收到 `session.abort` 时同时取消自己正在执行的 RPC。
2. **密钥只走一次握手**：`apiKey` 通过 `initialize` 的**子进程 stdin** 传入，**绝不放在 argv**（`ps` 全机可见）也不放环境变量（同用户可读、易被 `env` 打进日志）。内核只在内存持有。
3. **路径策略以壳为准**：内核传来的路径可能是模型编造的，壳必须独立做「是否在工作区内 / 是否命中禁止清单」的校验（纵深防御，两边都校验）。
   - **取消要穿透到在飞 promise**：`abort()` 除了通知内核，还必须 reject 在飞的 `chat.send`——否则壳会挂到 30 分钟超时，而 busy 已复位，用户能再发一轮 → 两个 agent loop 并发。
   - **写管道要处理背压**：`stdin.write()` 返回 false 时等 `drain`，否则大报文会堆在内存里。
   - **错误码只映射一处**（`protocol.rpcCodeFor`），两处各写一份必然漂移。
4. **协议要版本化**：`protocolVersion` 用整数，壳与内核不匹配时**拒绝启动**并提示「请重装扩展」，而不是带着半截语义跑。
5. **契约有唯一真相**：`protocol/contract.json` 列出全部方法、必填/可选参数与返回字段。两侧启动时各跑一次对账：

   | 侧 | 校验内容 | 失败表现 |
   | --- | --- | --- |
   | 壳（`src/contract.ts`） | 运行时注册的方法 ↔ 契约声明；契约 `version` ↔ `PROTOCOL_VERSION` | 日志 `error` + 一条警告，指出「已注册但契约未声明 / 契约声明但未注册」 |
   | 内核（`beecode/contract.py`） | 每次发 RPC 前：方法名存在、必填参数齐全、无拼错的多余参数 | 抛 `ContractError`，**在发出去之前**拦住 |

   为什么需要它：TS 的接口编译后消失、Python 也看不到 TypeScript，两侧方法名/参数名只能靠人肉同步。这份 JSON 把「人肉」变成「启动 100 ms 内的自动对账」。

   `id` 类型也在这条约定里：JSON-RPC 允许 `number | string`，壳发出的请求用自增 `number`，但收到对端的 `string` id 必须原样回显（`JsonRpcId`）。

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
    "autoAcceptDelayMs": 0,                  // 0 = 关闭"自动接受"倒计时
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
| 日志/遥测/崩溃上报 | ❌ | 统一走 `redact()` 过滤（`sk-*` 及 `gsk_`/`ghp_`/`AIza` 等厂商前缀、`Bearer *`、URL query 里的 key/signature、JSON 配置字段）；内核 stderr 同样过滤 |
| 内存（请求时） | ✅ | 仅存活于发请求的那几毫秒，`AbortSignal` 结束即释放 |

**解析顺序（v0.5 起）**：`SecretStorage` → 环境变量 `BEE_CODE_API_KEY` → 都没有则报「未配置」。

环境变量只作为**兜底**，不替代 SecretStorage：前者对整个进程可见（任何子进程、调试器都能读），所以永远排在显式配置之后。它解决的是"CI / 不想把 key 存进凭据库 / 临时换 key"这类场景。

**设置作用域也是安全边界**：

| 设置 | scope | 原因 |
| --- | --- | --- |
| `beeCode.model.baseUrl` | **machine** | 若允许工作区覆盖，一个恶意仓库的 `.vscode/settings.json` 就能把提问、代码片段和密钥发到攻击者端点（而且用户在受信任工作区里不会看到任何提示） |
| `beeCode.model.apiKeyId` | **machine** | 工作区没有理由改`SecretStorage` 的键名 |
| `beeCode.model.model` | window | 改模型名只影响回答质量，不改变数据去向 |

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

### 5.6 视觉能力：不靠模型名猜（已实现）

判断"这个模型能不能收图片"有三种来源，按可靠性排序：

| 来源 | 可靠性 | 说明 |
| --- | --- | --- |
| `beeCode.model.supportsVision: on/off` | 100% | 只有用户知道自己连的是什么；作为**覆盖**，不参与猜测 |
| 服务端反馈（缓存） | 高 | 带图成功过 → True；被明确拒绝过 → False；按 `baseUrl + model` 记 |
| 未记录 | — | **乐观**：先带图发 |

自愈流程：

```
模型返回 400/415/422 且错误里出现 image / vision / modality / image_url …
        │
        ├─ 剥掉消息里的 image_url，换成「【图片已省略：当前模型不接受图像输入】」
        ├─ 缓存 False（后续轮次直接不带图）
        ├─ ui.tool(guard, error) 提示用户 + log 一条 warn
        └─ 重试一次（成功即继续本轮）
```

为什么不再枚举模型名：名单永远滞后于新模型，也挡不住私有部署改名（`--served-model-name`）；
而"试一次"的代价只是一次请求往返，且失败后永久记住。

边界：只认**明确的图片拒绝**（`400/415/422` + 相关措辞），参数错误、额度不足等 400 不会被误判成"没视觉"。
缓存只在进程内有效（内核重启后重新学习），避免把一次临时故障记成永久结论。
### 5.8 思考内容：只看不回传（已实现）

部分模型会在 SSE 里单独返回思维链，字段各不相同：

| 来源 | 字段 |
| --- | --- |
| DeepSeek-R1 | `delta.reasoning_content` |
| OpenRouter | `delta.reasoning` |
| 部分网关 | `delta.thinking`（字符串或 `{text}`） |

处理策略：

| 方面 | 行为 |
| --- | --- |
| 抓取 | 依次识别上述三个字段，统一成 `ChatDelta.reasoning` |
| UI | 广播 `ui.reasoning`；面板渲染成本轮复用的「思考过程」折叠块，答题开始时自动收起 |
| 上下文 | **不写入 messages**，也不参与摘要；但会随 assistant 消息落进会话 JSONL 的 `reasoning` 字段，供回看 |
| 回传 | 默认**不回传**（`model.reasoningReplay=auto`）；服务端报错要求 `reasoning_content` 时自动补上并重试一次 |
| 强制策略 | `always` 总是回传；`never` 从不回传（兼容明确禁止回传的模型） |

回看：思考内容**按模型调用分段**（`[{round, text}]`）随 assistant 消息持久化，
**轮次结束、切换会话、重载窗口后仍然存在**，
在面板里显示为默认折叠的「思考过程 · 第 N 次调用」块；它不参与模型上下文，所以跨轮不会"复活"进 prompt。
回传只发生在同一轮内的 assistant 工具调用消息上。
### 5.7 错误处理

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
3. 再动笔：用 apply_patch 产出改动，一次一个文件，patch 用标准 unified diff（结果会作为提案给用户预览）。
   （用户会逐个文件「接受 / 拒绝」你的提案，接受后才写盘 —— 你不需要在回复里再请求一次批准。）
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
- **诊断为空 ≠ 代码没问题**：`diagnostics.get` 只返回「已被语言服务分析过」的文件；
  刚打开窗口时可能只有少数文件有值。诊断为空时明确写「未获得诊断信息，可能是工程尚未分析」，
  而不是断言「没有编译错误」。

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

### 7.1 循环状态机（已实现）

```
用户输入 ──▶ 组装消息（system + 摘要 + 历史 + 本轮）
                 │
                 ▼
          ┌──▶ 调模型（流式，带 tools）──── ui.delta ──▶ 面板
          │        │
          │        ├─ 有 tool_calls ──▶ 逐个执行（超时/异常 → tool 消息）
          │        │                       │
          │        └───────────────────────┘ 结果回灌，继续
          │
          └─ 无 tool_calls ──▶ 守卫检查（空响应/计划完成度/提前收工）
                                   │
                                   └─▶ 完成：写入会话 + ui.usage
任意时刻 ──abort──▶ CancelledError 穿透 ──▶ chat.send 返回「本轮已取消」
```

```python
# 实际实现：beecode/loop/agent.py
async def run_turn(self, session, *, text, attachments, history, summary) -> TurnStats:
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

### 7.2 工具清单（已实现）

| 工具 | 类型 | 主要参数 | 说明 |
| --- | --- | --- | --- |
| `list_files` | 只读 | `glob?`, `max_results?` | 工作区文件树（已过滤 .gitignore/node_modules） |
| `read_file` | 只读 | `path`, `start_line?`, `end_line?` | 分片读取；单次返回上限 256KB/2000 行，超出标 `truncated` |
| `search_code` | 只读 | `query`, `regex?`, `glob?`, `files_only?` | `files_only` 用于召回阶段省 token |
| `file_outline` | 只读 | `path` | 符号大纲（函数/类/方法 + 行号区间） |
| `find_symbol` | 只读 | `query`, `max_results?` | 全工作区按名字找定义（LSP 优先，fallback 文本） |
| `find_references` | 只读 | `path`, `symbol` | 引用位置（LSP） |
| `get_diagnostics` | 只读 | `path?` | LSP 诊断（编译错误、lint） |
| `propose_edit` | 提案（不写盘） | `path`, `content`, `summary` | **唯一改文件入口**：完整全文 → 提案 → 广播 `proposal.changed` |
| `run_command` | 执行 | `command`, `cwd?`, `timeout_ms?` | 受权限/沙箱约束（§12.4），可能要用户批准 |
| `spawn_subagent` | 派生 | `task`, `max_steps?` | 只读子代理（独立上下文），只回传结论；仅主代理可用 |

> 与设计稿的差异：暂未提供 `apply_patch`（unified diff）与 `run_test`——前者留作后续（全文提案更简单、冲突检测更可靠），后者等命令执行稳定后再做。

工具定义要求：**描述写给模型看**（何时用、何时不用、返回什么），**schema 写给校验用**（`additionalProperties: false`），**权限写给审批用**（`kind: 'read' | 'write' | 'exec'` + `readOnlyHint` 类似物）。

### 7.3 循环守卫（防死循环 / 防烧钱）

| 守卫 | 实际阈值 | 触发行为 |
| --- | --- | --- |
| 步数上限 `maxSteps` | 12（可配） | 追加「不要再调工具，基于已有信息收尾」并继续一次；仍超限则停止 |
| 空响应 | 连续 2 次空文本且无工具调用 | 先催一次；仍空则报错（不静默结束） |
| 重复动作 | 相同 `(tool, args)` 第 3 次 | 拦截并回填「结果不会变，请换策略」；第 4 次终止本轮 |
| 结果无变化 | 连续 3 次工具结果哈希相同 | 回填 `no_progress` 错误，要求换策略或总结 |
| 计划未完成 | 计划里**非最后一步**仍有 pending/doing，且模型不再调用工具 | 催一次「计划里还有未完成步骤」；最后一步规定为总结，可以留到最后 |
| 提前收工 | 用户要求改代码但本轮 0 个提案 | 追问「你还没有提交任何修改」，允许一次补提案 |
| 单工具超时 | `toolTimeoutMs`（默认 60s） | 中止该工具，把 `timeout` 错误回填给模型，并标记 `ui.tool(error)` |
| 工具异常 | 任意异常 | 捕获后回填 `{error, kind}`；**不中断循环**，模型可改策略 |
| 用户中断 | 随时 | `task.cancel()` → `CancelledError` 穿透 → `chat.send` 返回「本轮已取消」 |

> 设计要点：守卫要「先提醒、再停止」。直接硬停会让用户觉得模型「卡住了」；先插入一条系统提示纠正策略，往往能自愈。

### 7.4 意图分析驱动一切（已实现）

**没有 auto 模式，也没有手动模式**：每一轮提问都先用主模型做一次结构化意图分类，
拿到的 `mode` 直接决定这一轮怎么干；面板只显示一个模式徽标，不显示分析内容。

```
用户输入（面板不再传模式）
      │
      ▼  非流式分类调用（chat 语义，temperature=0）
{ mode, scale, needs_proposal, reason, intent }
      │
      ▼
ui.intent {mode, intent, reason, scale, needsProposal, degraded}   ← 面板只更新徽标
      │
      ├─ intent 写入轮次记录（供后续模型摘要）
      ├─ needs_proposal → 本轮没提案就追问（防"只说不做"）
      ├─ scale=large → 提示先 update_plan
      ▼
system_prompt(mode) → loop
```

分类器契约（`beecode/router.py`）：

| 字段 | 取值 | 用途 |
| --- | --- | --- |
| `mode` | `chat` / `builder` / `debugger` | 选提示词；决定守卫语气 |
| `scale` | `small` / `large` | `large` 才建议计划 |
| `needs_proposal` | bool | builder/debugger 默认 true |
| `intent` | 一句话 | 持久化，供摘要按意图总结 |
| `reason` | 一句话 | 面板提示用 |

**同一意图由模型判定**：每一轮**都调用分类器**，并把上一轮意图（目标/规模/模式/是否提案）作为输入，
上一轮意图存在 `session meta.lastIntent`（壳持久化），每次 `chat.send` 带回内核，
所以**内核重启后第一轮**也能判断"是否延续"；分类器拿到的是完整四要素
（目标 / 任务规模 / 模式 / 是否需要产出提案），不是只有一句话。
聊天回滚时，`lastIntent` 也从保留的最后一轮 turn record **完整回退**（四个字段都存），
不会出现"意图回滚了、规模/模式还停在已删除轮次"的情况。
要求模型输出 `continue_previous`。是延续 → 沿用上一轮的意图标签与模式（`ui.intent.reused=true`）；
不是 → 用新的意图。**没有"继续/好/ok"正则**——措辞相同但目标变了，模型也能判出来。

降级：服务端不支持 `json_schema` → `json_object` → 纯文本解析；输出非法时带着错误要求
模型重试（最多 2 次）；仍失败 → 退回 chat 并标记 `degraded`（面板提示"降级判定"）。

#### 长任务的可靠性保障（已实现）

| 机制 | 行为 |
| --- | --- |
| 计划模板 | `large + needs_proposal` 时内核**预置** 4 步骨架（读 → 改 → 测 → 总结），模型可直接沿用或 `update_plan` 重写 |
| 步数放宽 | `scale=large` 时用 `beeCode.agent.largeTaskSteps`（默认 24），普通任务用 `agent.maxSteps` |
| 计划持久化 | `ui.plan` 写入 `turns.jsonl` 与 `session meta`；重载后面板恢复，下一轮作为 system 注入未完成步骤 |
| 计划状态 | **只由模型 `update_plan` 修改**；内核不根据 `propose_edit` / 收尾自动推断完成度 |
| 计划参与收尾 | 模型不再调用工具时，若计划里**非最后一步**仍有 pending/doing，就催一次「计划还有未完成步骤」，并要求它用 `update_plan` 把已完成的步骤标 done（不能只口头说完成）；最后一步规定为总结，可以留到最后；同一轮只催一次，避免死循环 |
| 提案联动 | 接受提案后，面板把提到该路径的步骤标为 done，并同步到 session meta |
| 自动快照 | `needs_proposal=true` 的轮次开始时自动 `checkpoint.create`（失败只记日志） |
| 轮预算 | `agent.maxTurnTokens`（默认 200k）+ 墙钟：普通任务 `agent.maxTurnSeconds`（默认 600s），大任务 `agent.largeTaskSeconds`（默认 1800s）；到 **80%** 先注入一条"优先收尾"的 system 提示；用尽后先自动建**检查点**，再禁用工具要求模型收尾，并跳过"没提案"追问 |

收尾时不会再给工具（`tools=None`），避免模型在"该总结了"的时候继续调工具。


| 机制 | 行为 |
| --- | --- |
| 步数放宽 | `scale=large` 时用 `beeCode.agent.largeTaskSteps`（默认 24），普通任务用 `agent.maxSteps` |
| 计划持久化 | `ui.plan` 写入 `turns.jsonl` 与 `session meta`；重载后面板恢复，下一轮作为 system 注入未完成步骤 |
| 计划状态 | **只由模型 `update_plan` 修改**；内核不根据 `propose_edit` / 收尾自动推断完成度 |
| 提案联动 | 接受提案后，面板把提到该路径的步骤标为 done，并同步到 session meta |
| 自动快照 | `needs_proposal=true` 的轮次开始时自动 `checkpoint.create`（失败只记日志） |
| 轮预算 | `agent.maxTurnTokens`（默认 200k）+ 墙钟：普通任务 `agent.maxTurnSeconds`（默认 600s），大任务 `agent.largeTaskSeconds`（默认 1800s）；到 **80%** 先注入一条"优先收尾"的 system 提示；用尽后先自动建**检查点**，再禁用工具要求模型收尾，并跳过"没提案"追问 |

收尾时不会再给工具（`tools=None`），避免模型在"该总结了"的时候继续调工具。

**为什么删掉 auto 模式**：既然每轮都要分类，再保留一个"自动/手动"开关只会让 UI 与真实
决策不一致。按钮删掉、徽标常显，用户始终能看到这一轮被判定成了什么。
--- | --- | --- |
| `mode` | `chat` / `builder` / `debugger` | 选提示词；决定守卫语气 |
| `scale` | `small` / `large` | `large` 才建议计划 |
| `needs_proposal` | bool | **防止"只说不做"**：builder/debugger 默认 true |
| `reason` | 一句话 | 显示在面板 hint，便于用户理解为什么切了模式 |

约束与降级：

| 情况 | 行为 |
| --- | --- |
| 服务端不支持 `json_schema` | 降级 `json_object` → 再降级纯文本 + 正则抠 JSON |
| 输出不是 JSON / mode 不在三类 | 带着错误信息要求模型重试（最多 2 次） |
| 仍不合法 / 网络失败 | 退回 `chat`（`degraded=true`），并在 hint 标注"降级判定" |

为什么用模型而不是关键词：模式判断依赖语气、上下文与隐含意图（"帮我看看这段为什么崩"
和"这段在干嘛"字面相近，意图不同），关键词表既写不全也会误伤；而一次 non-streaming
分类调用的成本约等于主回答的百分之一，换来的是准确的模式与提案预期。

手动覆盖仍然有效：面板点 Chat/Builder/Debugger 时不再调用分类器，`mode` 不是 `auto`，
builder/debugger 直接按"需要提案"处理。
--- | --- |
| 报错/异常/崩溃关键词（且无解释意图） | `debugger` |
| 实现/新增/重构/修改/删除… | `builder` |
| 解释/为什么/区别/原理… | `chat` |
| 都没有 | `chat`（保守，不主动进入"改代码"语气） |

规模判定（`large` 才建议计划）：描述 ≥240 字、提到 ≥3 个文件名、出现"整个/重构/迁移/所有/架构"、或 ≥8 行。

为什么不用模型分类：多一次调用 = 延迟与成本翻倍，而分类错误代价很小（工具集相同，
只是提示词侧重不同）。拿不准时归 `chat` 是安全的。

手动覆盖：面板点 Chat/Builder/Debugger 即进入对应模式，`chat.send.mode` 不再是 `auto`。

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

### 8.2.0 三个检索工具怎么选

| 问法 | 工具 | 返回 |
| --- | --- | --- |
| "哪些文件里出现过 X" | `search.grep(filesOnly: true)` | 文件 + 命中次数（不含行文本，~200 token） |
| "X 在第几行、上下文是什么" | `search.grep` | 命中行（带上下文） |
| "**哪里定义**了 X" | `symbols.search` | 符号 + 路径 + 行范围（定义级，最准） |
| "X **在哪些地方被用到**" | `symbols.references`（用 outline 拿到的行做入参） | 引用位置列表 |
| "这个文件里有哪些函数" | `symbols.outline` | 函数/类清单 + 行范围 |

典型流水线（"找出所有处理上传的函数"）：

```
grep(filesOnly) 或 symbols.search  → 候选文件 / 候选符号
  → symbols.outline（非 LSP 语言兜底）
  → read_symbol 只读命中的函数体
  → 汇总并声明覆盖率（检索词、是否截断、未覆盖目录）
```

`symbols.search` 的 `source` 字段很重要：`lsp` 表示走了语言服务索引（可信），
`fallback` 表示退化成"grep + outline"扫描（**可能不全**，最多扫 40 个候选文件）。
调用方（内核提示词）应据此决定措辞："没找到" 还是 "搜索受限，可能有遗漏"。
**检索的四道安全阀**（`searchAdapter`）：模型会生成任意正则，而 **JS 正则不可中断**——一个 `(a+)+$` 就能把扩展宿主卡死。

| 阀 | 阈值 | 触发行为 |
| --- | --- | --- |
| 正则长度 | 300 字符 | 拒绝，提示改用关键词 |
| 嵌套量词启发式 | `(…+)+`、`a++`、`[…]*+` | 拒绝（"可能引发灾难性回溯"） |
| 单行匹配长度 | 2000 字符 | 只匹配前缀（正则代价随长度指数上升） |
| 整体扫描时间 | 5 秒 | 带 `truncated: true` 提前结束并记 warn |

另外两个语义细节：`caseSensitive` 默认 **false**（找常量/类型名时要传 true）；`hits[].text` 统一是**裸行**，上下文放 `context`、同行多次匹配放 `count`。
### 8.2.1 读文件：按「这次读多少」限流，而不是按「文件多大」拒绝

v0.4 起把闸门从"文件大小"挪到了"单次返回量"，因为用户的目标往往是**读大文件里的某几行/某个函数**：

| 层 | 阈值 | 作用 |
| --- | --- | --- |
| 整文件大小 | 512 KB | 只决定**走哪条路径**：≤512KB 整份打开（能拿 `version`、能看到未保存内容）；>512KB 改流式按行读 |
| 单次返回字节 | 256 KB | 硬闸门：无论文件多大，一条工具结果不会超过它 |
| 单次返回行数 | 2000 行 | 同上，防止"一行都没有但行数极多"的文件 |
| 二进制探测 | 前 8 KB 含 NUL | 直接拒绝，避免把乱码塞进上下文 |

流式读的实现要点：`createReadStream` + `readline`，**读到 `endLine` 就停**。
所以"在 500 MB 日志里读第 5000–5010 行"只占十几 KB 内存，返回 3 行、约 150 字节（实测）。

返回值现在带三个可用字段：

```ts
{ text, version?, totalLines?, startLine, endLine, truncated }
```

- `version` 只在"编辑器文档"路径存在（磁盘读取省略——`0` 会和真实版本 0 混淆）
- `totalLines` 在流式读取没到文件尾时**未知**（省略），不要假设它一定有
- `truncated` 为 true 时，调用方应改用更窄的行范围，而不是以为文件就这么点内容

### 8.2.2 在超大文件里读一个函数：先定位，再按范围读

**不要猜行号。** 推荐的两步流程（也是 Aider/Claude Code 的做法：先给结构，再精确读）：

```
1) symbols.outline(path) → [{ name, kind, startLine, endLine, container }, …]
   从里面挑目标符号（支持 "ConfigParser.parse" 这种带容器的路径）
2) fs.read(path, startLine, endLine) → 只读那个函数
```

内核侧已经封装成一行：

```python
result = await shell.read_symbol("src/huge.ts", "parseConfig")
# 内部：outline → 精确匹配 / 后缀匹配 → 按 range 读 → 返回 ReadResult（含 truncated）
```

三条配套建议：

> ⚠️ 查引用的正确姿势是 `shell.references_of_symbol(path, symbol)`：它先 outline 拿 `selection`（标识符位置），再调 `symbols.references`。用 `range.startLine` 会把位置落在前导注释上，参考提供者常常解析不到符号、返回空结果。

| 场景 | 做法 |
| --- | --- |
| 用户说"看看 `parseConfig` 怎么实现的" | `read_symbol`，一次拿到函数体 |
| 用户只给了一个模糊描述 | 先 `outline` 把候选符号列表给模型，让它选，再读 |
| 函数体本身 > 2000 行（罕见） | 返回 `truncated: true`，再按 `startLine` 续读下一段 |

这样即使文件有十万行，进入上下文的也只有目标函数那几十行——**上下文成本由"你要看什么"决定，而不是"文件多大"**。
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
- 生成提案时记录 `document.version`；此后用户手改了同一文件 → 接受时版本不匹配 → 提案标 `stale`，要求重新生成（详见 [§10.6](#106-冲突与并发)）。

### 8.5.1 附件上限（已实现）

代码选区/文件附件在**壳侧**就做了限制，避免一次塞爆上下文：

| 设置 | 默认 | 行为 |
| --- | --- | --- |
| `beeCode.attachments.maxCount` | 10 | 超过则忽略新附件并提示 |
| `beeCode.attachments.maxCharsPerItem` | 40000 | 单个附件截断并追加"…（附件已截断）" |
| `beeCode.attachments.maxTotalChars` | 120000 | 合计超限时**截断到剩余额度**并提示；额度用尽才拒绝 |

超限时会给**明确提示**（合并后的单条 toast + 面板系统消息 + 日志）：
250ms 内的多条提示会去重合并（多选 20 个文件也只弹一次）；文案分别对应
"只保留了前 N 段" / "已截断" / "已截断到上限"。
内核还有一道**防御性上限**（单项 40k / 合计 120k），旧版壳或被篡改的输入也会被夹取。

### 8.6 光标上下文：先读"用户正在看的那个函数"（已实现）

用户提问时通常就在看某段代码。与其让模型先大范围 grep，不如**直接把光标所在的整个函数摆在它面前**：

```
用户光标在 src/config.ts:42
        │
        ▼  （壳在发送前计算，纯函数 + LSP 符号表）
包含 42 行的最内层函数 parseConfig()：第 30-58 行
        │
        ├─ 找到 → 附件 = 第 30-58 行（标题「光标附近的代码 · 函数 parseConfig」）
        ├─ 不在函数里 → 附件 = 光标上下 30 行（可配）
        └─ 函数 > 300 行 → 退化成上下 30 行，并标记 truncated
        │
        ▼
chat.send { attachments, focus: {path, line, startLine, endLine, kind, symbol} }
        │
        ▼
内核追加一条 system 提示：「用户当前光标在 …，优先基于附件回答，信息不足再搜索」
```

关键设计：

| 点 | 做法 | 原因 |
| --- | --- | --- |
| 判定"函数" | `DocumentSymbol` 的 Function / Method / Constructor | 类、变量、import 都不是"一段可解释的代码" |
| 最内层优先 | 递归找包含光标的最小函数 | 嵌套函数/方法里，用户看的是内层 |
| 选区 | 整个选区在同一函数内 → 扩成整个函数；跨函数 → 选区 ±2 行 | 尊重用户选择，但避免把半个函数送给模型 |
| 大函数 | 超过 `beeCode.focus.maxLines`（默认 300）就退化 | 800 行的函数会直接撑爆上下文 |
| 自动附加 | `beeCode.focus.autoAttach`（默认开）；用户已手动附加时不重复 | 第一次提问就带上下文，省一轮工具调用 |
| 提示词 | "先基于附件回答，不足再 search_code / read_file" | 防止模型无视附件直接全库搜索 |

命令「附加选区」也走同一套逻辑：没有选区时取光标所在函数，而不是什么都不做。

**隐式选区高亮**（`src/focusDecoration.ts`）：发送时把"agent 实际读了哪一段"用虚线框画在编辑器里，
5 秒后自动消失；悬停显示「Bee Code 读取了这段代码（函数 parseConfig）：第 30-58 行」。
设置 `beeCode.focus.highlight` 可关闭。这样用户能立刻判断"它是不是看错地方了"。

**高亮跟随**：模型通过工具读文件时，内核广播 `ui.read {path, startLine, endLine, tool}`：

| 文件状态 | 表现 |
| --- | --- |
| 在可见编辑器里 | 在读取范围上叠加**第二层高亮**（左侧实线 + 淡背景），与"用户光标"的虚线框区分开；最多保留 12 段，6 秒后清除 |
| 没打开 | 不抢焦点去打开它；改为在**面板顶部把文件名亮成 chip**（`a.ts:10-20`，带 1.2 秒高亮动效，最多 8 个） |

这样"它先读了你的函数，又去看了别的文件"整个过程都可见；没打开的文件也不会打断编辑。

**点击跳转**：chip 是按钮，点击后用 `resolveTarget` 解析路径 → 打开（预览模式，不污染标签页）→
光标放到起始行、滚动到范围居中。webview 消息按不可信处理：只接受工作区相对路径，
拒绝绝对路径与 `..`，行号必须有限（`parseOpenRead` 有单测覆盖）。
跳转后会在编辑器里**重新画一次读取范围高亮**（6 秒后消失）——chip 可能已经存在很久，
实时高亮早过期了，重画才能让人看清"当时读的是哪一段"。

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
   **命令 id 与 `package.json` 在启动时对账**（`undeclaredCommands()`）：声明了没注册 → 点击报 `command not found`；注册了没声明 → 命令面板看不到。
2. **采集**：`vscode.window.activeTextEditor` → `selection`（支持多选区：逐个取，**按 `路径:起行:止行` 去重**）→ `document.getText(range)`。
   路径一律转成**工作区相对路径**（绝对路径会把用户名带进 prompt）；`untitled:` 文档没有真实路径，用 `untitled: true` 标记，内核不会拿它去 `fs.read`。
3. **上下文扩展**：用 `vscode.executeDocumentSymbolProvider` 拿到光标/选区所属的符号，向上扩到函数边界（避免只给半截 `if` 块）；再补「文件头 40 行（imports）+ 相邻 20 行」作为最小可理解单元。
4. **投递**：命令里 `await vscode.commands.executeCommand('beeCode.chatView.focus')` 后 `postMessage({ type: 'attachSelection', payload })`；面板渲染成 chip，用户可删、可再选。
5. **大选区策略**：> 200 行时只附 `file_outline` + 选区首尾各 40 行，并在 chip 上标注「已折叠（共 800 行）」，模型需要时再用 `read_file` 精读。
6. **不打断输入**：若用户正在输入，把选区插入为 chip 而非覆盖草稿。

> 工程细节：`when` 条件里不要用 `resourceScheme == file` 之外的复杂表达式，否则在 diff 编辑器、notebook、虚拟文档里会误显示。对只读文档（diff 侧、预览侧）要提前 `return`。

---

### 9.3 会话存储：完整历史全量落盘

**结论：完整对话永不丢，但模型只拿其中一小段。** 两件事分开做，是这一节和第 9.4 节的全部内容。

#### 目录选择

推荐 `<globalStorage>/sessions/`（默认），可用 `beeCode.session.dir` 覆盖：

| 候选 | 优点 | 缺点 | 选择 |
| --- | --- | --- | --- |
| `context.globalStorageUri` | 按扩展隔离、升级保留、卸载时由 VS Code 清理 | 路径不直观 | ✅ **默认** |
| 用户主目录 `~/.beecode/sessions` | 可读、可跨编辑器（Cursor/Windsurf）共享 | 卸载不清理，需要自己管 | 可选（配置覆盖） |
| 工作区 `.beecode/sessions` | 跟着仓库走、可提交 | **隐私风险**：聊天记录可能被 commit；`.gitignore` 又容易配错 | ❌ 不用 |
| `workspaceStorage` | 天然按工作区隔离 | 工作区移动/重命名后变成孤儿 | 用索引里的 `workspace` 字段代替 |

布局：

```
<globalStorage>/sessions/
├─ index.json            ← 会话索引（标题/时间/条数/上次停在哪），原子写
├─ s_173...a1.jsonl      ← 完整对话，一行一条，只追加
└─ s_173...b2.jsonl
```

#### 为什么是 JSONL + 索引

| 设计 | 理由 |
| --- | --- |
| **追加写**（`appendFile`） | 崩溃最多丢最后半行；整份重写会丢掉整个会话 |
| **坏行跳过** | 读的时候逐行 `JSON.parse`，一行坏了不影响其余（实测：追加一行 `{broken` 后仍能读出 30 条） |
| **索引独立、原子写**（`.tmp` → `rename`） | 列表页要快速枚举，不该为了显示标题去解析每个 JSONL |
| **标题取第一条用户消息前 40 字** | 零成本的可读标题，用户可以后来重命名 |
| **不存密钥、不存提案正文** | 密钥只在 `SecretStorage`；提案正文体积大且可重新生成 |

#### 与重载的关系

`sessionId` 存在 `context.globalState`（`beeCode.sessionId`），所以重载后自动续上同一个会话；`meta.status` 记录"上一轮停在哪"，按 §9.5 的三条规则处理。

命令：`Bee Code: 新建会话` / `Bee Code: 历史会话…`（QuickPick 列出标题 + 时间 + 条数）。

### 9.4 上下文管理：分层、预算、压缩

**核心原则：transcript 可以无限长，模型上下文必须有上限。** 主流 agent 的做法可以归成三条：

| 做法 | Claude Code | Codex | Cline | Aider |
| --- | --- | --- | --- | --- |
| 硬截断（只留最近 N） | ❌ | ❌ | ❌ | ⚠️ 溢出时才 |
| 摘要压缩（compaction） | ✅ 接近上限自动压缩，`/compact` 手动 | ✅ auto-compact | ✅ 上下文截断 + 摘要 | ✅ 触发时总结 |
| 外部记忆（按需检索） | ✅ `CLAUDE.md` + 文件按需读 + 子代理隔离 | ✅ 项目文档 + 工具读取 | ✅ 文件按需读 | ✅ repo map |
| 工具输出限幅 | ✅ 25k token 上限 | ✅ | ✅ | ✅ |

结论：**没人把完整历史直接喂给模型**，都是"摘要 + 最近若干轮 + 按需检索"。区别只在压缩时机与摘要由谁生成。

#### Bee Code 的分层

```
L0 系统提示 / 模式提示                         固定 ~1k tokens
L1 早前对话摘要（模型按"意图"生成）              ≤ 3k（占预算一半）
L2 最近 N 条逐字（默认 8 条）                    余下预算
L3 当前轮附件 / 检索结果（内核自己拼）           单独预算，不进 history
```

实现分两段：

1. **机械裁剪**（`src/contextBuilder.ts`，纯函数）：切出"最近 8 条"，其余折叠；
   token 估算 CJK≈1/字、ASCII≈1/4；超预算先截摘要再从最旧的逐字消息丢。
2. **模型摘要**（`src/turnStore.ts` + 内核 `context.summarize`）：把被折叠的轮次
   交给主模型，按意图逐条总结成一句话。

模型摘要的输入/输出：

```jsonc
// 输入（壳侧持久化的轮次记录）
{ "turns": [
  { "intent": "修复配置崩溃", "assistant": "…", "tools": ["read_file","propose_edit"], "files": ["src/config.ts"] }
]}

// 输出（结构化 schema 约束）
{ "pairs": [
  { "intent": "修复配置崩溃",
    "summary": "调用了 read_file、propose_edit，改动了 src/config.ts，修复了空配置导致的崩溃" }
]}
```

句子必须覆盖三要素：**调用了什么工具 / 改动了哪些文件 / 实现了什么需求**。
壳把 `pairs` 拼成 `- 意图：总结` 的文本作为 L1；失败或 mock 内核返回空时退回机械摘要。

**增量摘要**：只把新折叠进来的轮次发给模型，结果追加到已有摘要行之后，
成本从 O(n²) 降到 O(n)；摘要超预算时从**最旧的行**开始丢（保留最近结论）。

**摘要持久化**：摘要写到 `<sessions>/<sessionId>.summary.json`
（`{covered, coveredMessageIndex, lines, updatedAt}`）。重载窗口时直接读回，**不再重算**；
聊天回滚时按 `messageIndex` 把摘要行截断到仍保留的轮次；如果会话文件被外部截短
（记录的 `coveredMessageIndex` 大于当前消息数），摘要整体丢弃重算，避免"摘要覆盖不存在的轮次"。
全程自动，没有手动"压缩"命令。

**会话标题**：每轮结束后用本次 `intent` 覆盖会话标题，比"第一条用户消息"更能概括当前会话。

#### 轮内压缩（in-turn compaction）

跨轮压缩管不到"同一轮里多次工具调用"——一次任务可能 10+ 次工具调用，结果全部堆在 `messages` 里。
`AgentLoop._compact()` 在**每次模型调用前**检查 token，按三档处理：

| 档 | 动作 | 说明 |
| --- | --- | --- |
| ① 观察摘要 | 旧工具结果替换成 digest（`{digest:true, tool, path/lines/exitCode, note}`） | 保留最近 3 条原文；仍超则连最近的一起折叠 |
| ② 丢交换 | 删除最早的 `assistant(tool_calls)` + 其工具回复 | 保留当前用户消息及之后，tool_call 配对不破坏 |
| ③ 模型兜底 | 把最早一半过程压成一段 system 摘要（一轮最多一次） | 仍不达标才用，成本最高 |

预算 = `contextWindow × 0.7`（`beeCode.model.contextWindow`，默认 32k）；token 估算用服务端
`usage.prompt_tokens` 做 EMA 校准（0.5–2.0），避免估算偏差导致预算失真。

工具结果本身也已按"观察"整形：`read_file` 超过 150 行给头 120 + 尾 30 + 省略提示；
`run_command` 给 stdout 头 100/尾 40、stderr 头 40/尾 10；`search_code` 每条命中截到 160 字、
最多 50 条；`list_files` 最多 200；`get_diagnostics` 给严重度计数 + 前 20 条。

轮次记录存 `<sessions>/<id>.turns.jsonl`（一行一轮），并带 `messageIndex` 与 JSONL 对齐——
聊天回滚时按同一行号截断，摘要缓存同时失效。
--- | --- |
| 机械摘要不"理解"内容 | 它只抽锚点；复杂推理的结论会丢。等有模型摘要再补 |
| 只按条数裁剪 | 不看语义重要性；一条超长的工具输出可能挤掉多条用户指令（缓解：工具输出在适配器层已有上限） |
| 单一预算 | 不区分模型窗口大小（31k vs 200k）；后续可按模型配置缩放 |
## 10. 改动落地：提案 + 逐文件审批（Proposal-then-Apply）

> **方向修正（v0.3，最终形态）**：v0.1 曾改为「直接写入 → Keep/Undo」，v0.3 又回到**先审后写**，但形态不同：
> 内核产出的是**虚拟文件（提案）**，源文件在用户点「接受」之前**一个字节都不动**。
> 逐文件审批 + 一键全部通过；拒绝则源文件保持原样、提案丢弃。

### 10.1 一次改动的完整生命周期

```
内核：算出「修正后的完整文件」→ 存在自己那边（_PROPOSALS）
  │
  ├─ notify proposal.changed { added: [{id, path, baseVersion, additions, deletions, summary}] }
  │     └─ 只有元数据，正文不推（可能几百 KB）
  │
用户：点「查看改动」
  │
  ├─ 壳 → RPC proposal.read {id} → {text}
  ├─ 壳：vscode.diff(真实文件, 虚拟文档)      ← 左=磁盘现状，右=提案内容（绿色=接受后会写进去的）
  │
用户：点「接受」
  │
  ├─ 壳 → RPC proposal.read {id} → {text}
  ├─ 壳：edit.apply({path, newText, expectedVersion: baseVersion})   ← 唯一写入点
  │    └─ 版本冲突 / 被锁定 → 不写，标 stale，提示重新生成
  └─ 壳 → RPC proposal.decide {id, decision: "accept"}               ← 写成功之后才通知

用户：点「拒绝」
  └─ 壳 → RPC proposal.decide {id, decision: "reject"}（磁盘零改动）
```

三档粒度全部由同一套机制表达：

| 操作 | 实际动作 |
| --- | --- |
| 逐文件接受/拒绝 | 对该提案调用一次 `accept` / `reject` |
| 全部接受 | 遍历所有 `pending` 提案，逐个 `accept`（某个失败不影响其余，最后汇总提示） |
| 全部拒绝 | 遍历并 `reject` |

### 10.2 三条硬规则

1. **先落盘、后告知**：`proposal.decide(accept)` 必须在 `edit.apply` 成功之后调用。反过来会出现「内核以为已应用，磁盘其实没变」——这是最难查的一类状态不一致。
2. **冲突检测用 `baseVersion`**：提案生成时记下当时 `document.version`；接受时作为 `expectedVersion` 传下去，文件被别人改过就拒绝写入（[§10.6](#106-冲突与并发)）。
3. **拒绝是零副作用**：不写盘、不建检查点、不改文件；只丢提案 + 一条审计日志。因此「先拒绝再反悔」不会留下任何痕迹（需要的话让 agent 重新生成）。

#### 10.2.1 落地时的六个细节（都在 `editAdapter.ts` 里）

| 细节 | 不这么做会怎样 |
| --- | --- |
| **新建文件走 `createFile` + `insert`**，而不是 `replace` | `replace` 对不存在的文件无效，`openTextDocument` 会直接抛错——"创建新文件"整条路径不可用 |
| **新建前先 `createDirectory` 父目录** | `createFile` 不会自动建目录，写 `src/deep/x.ts` 时失败 |
| **换行符跟随目标文件**（`doc.eol`；新文件跟随 `files.eol`） | CRLF 项目被写成 LF，`git diff` 显示整个文件都被改了，`.gitattributes` 规则被绕过 |
| **删除前检查 `doc.isDirty`** | 用户未保存的编辑会被静默丢掉 |
| **删除后不返回 `version`** | 返回的是删除前的旧值，调用方会拿一个已经不存在的版本号继续操作 |
| **单次写入上限 2 MB** | 模型抽风生成几 MB 文本时，整份内容会进 undo 栈，编辑器直接卡死 |

### 10.3 提案的数据结构

```ts
interface ProposalDto {
  id: string;                    // 稳定 id：查看/接受/拒绝都用它
  path: string;                  // 工作区相对路径
  baseVersion?: number;          // 生成提案时的 document.version（接受时做冲突检测）
  additions?: number;
  deletions?: number;
  status: 'pending' | 'applied' | 'discarded' | 'stale';
  summary?: string;              // 一句话说明，显示在卡片上
}
```

- 一个文件一个提案；同一文件再次生成提案会**取代**旧的（旧的自然过期）。
- 正文**不进通知**，只在内核内存里；壳需要时用 `proposal.read` 拉取，用完即弃（`diffAdapter` 的 LRU 缓存兜底）。
- 提案**不持久化**：窗口重载后壳侧的待审列表会清空，内核若还在运行会重新广播（`proposal.changed`）。
- `stale`：接受时发现文件已被改动 → 标脏并提示「请让 agent 重新生成」，**绝不覆盖**。
  stale 的提案**仍然显示在面板上**（灰色、虚线框、只能「查看 / 丢弃」）——直接消失会让用户以为看错了。
- **同路径去重**：一个文件只保留一个有效提案；新提案到来时，同路径的旧提案自动标 `stale`（否则用户可能先接受旧的，用旧内容覆盖新内容）。
- **正文缓存**：查看过的正文留在内存，接受时直接复用（省一次 RPC）。失效用**事件**而不是时间——任何 `upsert`（内核更新提案）都会丢弃该 id 的缓存；容量上限 3 条 / 8 MB，LRU 淘汰。**不设 TTL**：时间窗口既不能保证正确性，也管不住内存。

### 10.4 三个动词，严格区分

| 动词 | 语义 | 实现 | 会不会写文件 |
| --- | --- | --- | --- |
| **接受（Accept）** | 认可这个文件的提案，落盘 | `edit.apply` 整文件替换 → `proposal.decide(accept)` | ✅ 写（唯一入口） |
| **拒绝（Reject）** | 丢弃提案，源文件保持原样 | 只发 `proposal.decide(reject)` | ❌ 不写 |
| **恢复（Restore）** | 回到某个检查点（整轮/整个任务） | 影子 git 恢复（[§10.5](#105-检查点checkpoint回滚的地基)） | ✅ 批量写 |

**关键语义**：在用户点「接受」之前，**磁盘上没有任何改动**。所以这里不存在「Keep 不是 Save」的歧义——不接受就是不落盘。恢复（Restore）用于「已经接受了一堆改动，想整体退回去」，与逐文件审批是两条互补的退路。
### 10.5 检查点（checkpoint）：回滚的地基

采用**影子 git 仓库**（Cline 的做法），与项目 `.git` 完全隔离：

```
<globalStorage>/shadow.git     ← GIT_DIR（不污染项目）
<workspace>                    ← GIT_WORK_TREE（每次操作时现取）
```

```bash
git --git-dir="<shadow>" init -q --bare        # 注意：init 不能带 --work-tree
git --git-dir="<shadow>" --work-tree="<ws>" -c user.name=... -c user.email=... add -A -- .
git --git-dir="<shadow>" --work-tree="<ws>" -c user.name=... commit -q -m "checkpoint: turn 3" --allow-empty
git --git-dir="<shadow>" --work-tree="<ws>" diff --name-only <id>   # 预览将被覆盖的文件
git --git-dir="<shadow>" --work-tree="<ws>" checkout <id> -- .      # 真的回滚
```

实现（`src/adapters/checkpointAdapter.ts`）里有七条必须遵守的规则，每一条都对应一个真实故障：

| # | 规则 | 不这么做会怎样 |
| --- | --- | --- |
| 1 | **提交身份显式覆盖**：所有写操作带 `-c user.name=Bee Code -c user.email=beecode@localhost` | 没配过 `user.name` 的用户，`git commit` 直接失败（checkpoint 静默失效） |
| 2 | **`init` 单独一条命令**，不经过统一的 `git()` | `git --git-dir=X --work-tree=Y init --bare` 会报 `GIT_WORK_TREE ... not allowed without specifying GIT_DIR` |
| 3 | **工作区根每次现取**（getter，不在构造时冻结） | 用户切换/新增工作区后，快照写到旧目录 |
| 4 | **`list()` 从 `git log` 读**，不依赖内存数组 | 重载窗口后 UI 认为"没有检查点"，用户失去回滚入口 |
| 5 | **超过 retention 压缩历史**：用 `commit-tree` 以原 message 重建最近 N 个 commit 的父链，再 `reflog expire` + `gc --prune=now` | 单纯 `gc` 删不掉祖先（它们永远 reachable），`shadow.git` 只增不减 |
| 6 | **写操作串行化**（内部 promise 队列） | 并发 `create()` 撞 `index.lock`，报 `Unable to create .../index.lock` |
| 7 | **不可用时显式返回 `skipped + reason`**，而不是静默给空 id | 内核以为有了回滚点，实际没有 |

补充约定：

- **范围**：默认快照整个工作区；传 `paths` 时只 `add -- <paths>`（大仓库的轻量模式）。影子仓库会**继承工作区的 `.gitignore`**，但它只排除被忽略的路径——项目若没忽略 `node_modules`，快照就会把它收进去。
- **恢复只处理文件**。协议里的 `scope`（files/task/both）已移除：会话与任务状态属于内核，由内核先重置自身状态、再调 `checkpoint.restore` 把文件退回去——**壳不该假装能恢复它看不见的东西**。
- **保留数量**：`beeCode.checkpoint.retention`（默认 50）。压缩保留原 message，因此 `list()` 里的标签不会退化成 `compacted xxxxxxx`。
- **降级方案**：环境里没有 git 时退化为纯文件快照（能恢复、不能 diff）——⬜ 尚未实现。


#### 10.5.1 两个必须知道的约束

**① 压缩是按「滞后阈值」批量发生的，不是一到 50 就丢**

`threshold = retention + COMPACT_SLACK`（默认 `50 + 10 = 60`）。实测时间线（retention=50，连续建 61 个快照）：

| 快照数 | git 里的 commit 数 | 可访问范围 | 说明 |
| ---: | ---: | --- | --- |
| 50 | 50 | turn-1 … turn-50 | 未达阈值，不压缩 |
| 51 | 51 | turn-1 … turn-51 | **什么都没丢**（容易误解的一点） |
| 60 | 60 | turn-1 … turn-60 | 仍未达阈值 |
| 61 | **50** | turn-12 … turn-61 | 触发压缩：丢最旧的 **11 个**，保留最新 50 个 |

之后每加 11 个再压一次（72 → 丢 turn-12…22，依此类推）。加滞后量是为了避免「每来一个快照就重写 50 个 commit」，把摊销成本从 1/1 降到 1/11。

**② checkpoint id 跨压缩**不稳定**——内核不能长期持有它**

压缩用 `commit-tree` **重写父链**，所以保留的 50 个 commit 也会拿到**全新的哈希**（连刚建的那个也变）。实测压缩后逐个检查：

```
turn-1   id 95a34c7b 存在: false   ← 被压掉
turn-11  id 7cf01be1 存在: false   ← 被压掉
turn-12  id 82962aa0 存在: false   ← 内容保留了，但 id 变了
turn-55  id a544b8de 存在: false   ← 同上
turn-61  id e45d3a05 存在: false   ← 连最新的也变了
```

因此有三条使用纪律：

| 场景 | 正确做法 |
| --- | --- |
| 壳 / UI 展示 | 每次 `list()` 现读 git（已经这么做），不要缓存 |
| 内核要在「本轮结束时回滚」 | 只用**最近一次 `create()` 的返回值**，且中间不要再 `create()`（否则可能跨过一次压缩） |
| 需要跨会话/跨轮引用某个历史点 | **不要存 id**；存 `label`（如 `turn-3`）或时间戳，用前先 `list()` 重新解析成当前 id |

`restore` 拿到失效 id 时会以 `unknown revision` 失败——这是**预期行为**，不是 bug。

> 如果将来确实需要"id 永久稳定"，替代方案是改用 `.git/shallow` 做边界截断（`clone --depth` 的机制）：保留的 commit 哈希不变，但 shallow 仓库有若干命令行为差异。目前不做，因为「用前现查」已足够。


#### 10.5.2 聊天快照与"回滚范围"（已实现）

会话本身就是 append-only JSONL（一行一条消息），所以"某一刻的聊天记录"等价于**文件行号**。
检查点的聊天快照**只存行号**，不复制消息：

```
<globalStorage>/checkpoints/<checkpointId>.json
  { id, sessionId, line: 42, createdAt: ... }     ← 约 100 字节
```

| 选择 | 代码 | 聊天 | 后续快照 |
| --- | --- | --- | --- |
| **仅回滚代码** | 恢复到目标快照 | 保留，追加【回滚通知】系统消息 | 目标之后的代码快照 + 聊天快照**全部作废** |
| **代码 + 聊天** | 恢复到目标快照 | JSONL 截断到第 `line` 行，追加【回滚通知】 | 同上 |

"作废"：影子仓库 `git update-ref HEAD <目标 id>` 回退分支，再删除 `voided` 对应的快照文件；
之后的新检查点从目标点继续，`list()` 里看不到被作废的那几条。

**聊天回滚后的上下文重建**（`contextBuilder.buildContext`，每轮固定行为）：

```
截断后的前 N 条消息
   ├─ 最后 8 条      → 原样逐字发给模型
   └─ 更早的消息      → 机械摘要（用户要什么/动过哪些文件/出过什么错）
   +
最后追加一条 system：【回滚通知】…
```

摘要由 `buildContext` 在下一轮现算（`this.summary` 被重置为 `undefined`，
避免"预置摘要 + 现算摘要"重复折叠）。

两条一致性保证：

- 回滚后**清空待审提案**（它们基于旧代码，接受必然冲突）
- 回滚通知写入 JSONL，因此下一轮 `history` 里模型能看到"代码被回滚过"
### 10.6 冲突与并发

| 场景 | 处理 |
| --- | --- |
| 接受时文件已被用户改过 | `baseVersion` 与当前 `document.version` 不一致 → 拒绝写入，提案标 `stale`，提示「让 agent 重新生成」 |
| 用户正在同一文件里编辑 | 接受时以 `document.version` 为准：有未保存编辑也会被判为冲突，提示先保存/停止编辑 |
| 同一文件有多个提案 | 后生成的**取代**先生成的（旧提案自然失效），保证一次只决定一个完整版本 |
| 两个窗口 / 两个任务同时改同一文件 | 用 `document.version` + 内容 hash 双校验；写入串行化（每文件一个互斥队列） |
| 写入过程中文件被外部程序改 | `applyEdit` 返回 false → 重新读、重算、重试一次；仍失败则放弃并报错 |

### 10.7 写入门闸（Guardrails）

保留 Overlay 范式真正有价值的部分——**在写之前挡一下**，只挡高风险：

| 门闸 | 默认 | 说明 |
| --- | --- | --- |
| 敏感路径写前确认 | 开（**已实现**：`assertWriteAllowed` 对 `.env*`/`*.pem`/`.git/**`/CI 配置等再加确认） | `.env*`、`*.pem`、`*.key`、`id_rsa*`、`.git/**`、`.github/workflows/**`、`package.json` 的 `dependencies` 段（可配 `beeCode.review.gateGlobs`） |
| 大批量写前确认 | 开 | 单次 > 5 个文件 或 +/− 合计 > 300 行 → 「将改动 8 个文件 +420 −130，继续？」 |
| 删除文件 | 开 | 删除类改动单独确认，且强制先落检查点 |
| 自动 Keep | 关 | 可设延时（对标 `chat.editing.autoAcceptDelay`），倒计时内可撤销 |
| 全部关闭 | 允许 | 设置项里叫 `unsafe`，UI 上标黄 |

#### 10.7.1 确认框的四个硬要求（`interactionAdapter`）

写入门闸的效果**完全取决于确认框好不好用**。四条要求，缺一条它就会变成"盲点确认"：

| 要求 | 实现 | 不这么做会怎样 |
| --- | --- | --- |
| **必须解释"为什么问"** | `detail` 挂到每个 `QuickPickItem.detail`（选中行下方显示） | 用户只看到"是否继续？"，不知道对哪个文件、改多少行 |
| **必须有关闭路径** | 内核没给否定语义选项时，壳兜底追加「取消」 | 只有一个「继续」按钮的确认框，用户只能盲点 |
| **必须能被取消** | 接 `ctx.signal` → `CancellationTokenSource` 传给 `showQuickPick` | 内核 `abort` 后弹窗还挂着；用户点了也没意义 |
| **Esc = 拒绝** | 返回 `{choice: null}` | 把"用户没说 yes"当成同意，等于没有门闸 |

另外两条约定：

- **`rememberKey` 只用于低风险确认**。安全门闸（敏感路径、删除文件）**不要**传它——一次手滑就永久放行。想撤销时用命令 `Bee Code: 清除记住的确认选择`。
- **密钥白名单**：`secrets.get` 只允许 `beeCode.apiKey.*` 前缀。将来存了别的凭据（GitHub token、MCP key）时，内核也拿不到——"内核不需要"应该由壳来守。

### 10.8 仍然不执行代码

写入 ≠ 执行。`run_command` / `run_test` 仍默认关闭，需要 OS 级沙箱（[§14.3](#143-沙箱四个层级越往下越真隔离)）才可开启。**审批可以被说服，沙箱不能**——这条结论不因为改了审阅范式而改变。

---

## 11. 预览、逐文件审批与回滚

### 11.1 红绿从哪来：三种方案，从轻到重

| 方案 | 红绿来源 | 集成成本 | 用途 |
| --- | --- | --- | --- |
| **A. `vscode.diff`** | diff 编辑器渲染两份文档 | 极低 | **当前位置**：提案预览（左=磁盘现状，右=虚拟提案） |
| **B. `vscode.changes`** | 内置「更改编辑器」多文件视图 | 低 | 「本轮改了 8 个文件」的总览 |
| **C. SCM QuickDiff** | VS Code 在**真实文件**里画红绿 + gutter | 中 | 长期：接受后的"已应用改动"对照（依赖写入进文件） |

提案预览走方案 A，且方向是固定的：

```ts
// 左 = 真实文件（磁盘现状）；右 = 虚拟文档（提案内容）
await vscode.commands.executeCommand("vscode.diff", realFileUri, proposedVirtualUri, title);
```

所以用户看到的**绿色就是"接受后会写进文件的内容"**，红色是"会被替换掉的现状"。这比"先写盘再看 diff"更直观：不接受 = 什么都没发生。

方案 C 留给"已接受的改动"——那时文件里确实有新内容，QuickDiff 才有意义。

#### 11.1.1 `diffAdapter` 的三条实现约束

| 约束 | 为什么 |
| --- | --- |
| 路径必须走 `resolveTarget()` | 否则内核可以用 `../../etc/passwd` 让扩展把工作区外的文件内容渲染到编辑器里（只读，但仍是信息暴露面）；`path.resolve` 还依赖扩展宿主的 cwd |
| 虚拟文档内容表有上限（50 条 / 20 MB，LRU 淘汰） | 每次预览都存一份全文，一次会话审阅几十个大文件会持续吃内存 |
| 淘汰时跳过「当前正打开」的条目 | 若把正开着的预览内容清空，左侧会变成空文件——用户看到的是「整个文件都被删了」 |

另外两个行为：

- **同一文件重新提案时原地刷新**：若该文件的预览文档仍打开，复用同一个 URI 并触发 `onDidChange`，不再堆一个同名标签。
- **多文件总览用公开命令 `vscode.changes`**（`[修改后, 修改前, 基准]` 三元组），不用内部命令 `_workbench.openMultiDiffEditor`。

### 11.2 面板长什么样

```
┌ Bee Code · 待审提案（3 个文件）────────────────────────────────────┐
│ src/config/parse.ts                          +18 −6              │
│ 修复 parseConfig 对空值处理                            [查看改动] │
│                                            [接受]  [拒绝]        │
│ src/index.ts                                  +3 −3              │
│ 调用点跟随签名变更                                    [查看改动] │
│                                            [接受]  [拒绝]        │
├──────────────────────────────────────────────────────────────────┤
│ [全部接受]  [全部拒绝]  [恢复到检查点…]                            │
└──────────────────────────────────────────────────────────────────┘
```

- 一个文件一张卡片：路径 + 行数统计 + 一句话说明 + 三个动作（看 diff / 接受 / 拒绝）。
- 失效（`stale`）卡片保留显示但降级：虚线框、统计位置显示「已失效」、**没有「接受」按钮**（只剩查看/丢弃）。
- 顶部按钮是"全部接受 / 全部拒绝"；某个文件失败不影响其余，最后汇总提示。
- 状态栏常驻 `待审 N 个文件`，避免用户忘了还没决定的提案。

#### 11.2.1 面板与 Webview 的三条约定

| 约定 | 原因 |
| --- | --- |
| **`status`（轻量：mode/busy/hint）与 `state`（全量快照）分开** | 高频更新（每轮 busy/hint）不能重发整段历史；只有 webview 首次加载、恢复会话、消息被裁剪时才发全量 |
| **助手消息必须写进 `state.messages`** | 前端收到 `state` 会清空重渲染；流式文字若只走 `delta`，回合结束的 `pushState` 会让它「消失」 |
| **消息列表上限 300 条** | Webview 的 DOM 不该随会话无限增长；裁剪后强制重发一次快照，保证 DOM 与 state 一致 |

流式细节：`delta` 只发增量；回合结束时壳再把「权威全文」作为一条 assistant 消息发过去，前端用它**覆盖**流式节点（而不是追加），避免重复。

**无障碍（流式场景的标准做法）**：

```html
<section id="messages" aria-live="polite" aria-busy="false">…</section>
<div id="sr-status" class="sr-only" aria-live="polite"></div>   <!-- 视觉隐藏，仅屏幕阅读器可见 -->
```

| 时机 | 动作 |
| --- | --- |
| 第一条 `delta` | `aria-busy="true"`（先别自动播报）+ 播报「助手开始回复」 |
| 定稿 assistant 消息 | `aria-busy="false"` + 播报「助手回复完成，共 N 字」 |
| `status.busy=false` | 兜底复位 `aria-busy` |
| 待审提案变化 | 播报「待审提案 N 个」 |

`aria-busy` **只影响播报时机，不影响渲染**：视觉上文字照旧逐字出现，屏幕阅读器不会在每个 40ms 分片上念一遍。
- 没有"逐函数"这一层：一个文件一次决定（保留扩展点，见 §11.4）。

### 11.3 四个容易踩的边界

1. **部分接受**：接受 A、拒绝 B 后，磁盘上是"只有 A 的新内容"——这完全正常，因为每个文件是独立的完整替换，不存在"半个文件"的中间态。
2. **文件在提案生成后被改过**：`baseVersion` 不匹配 → 接受失败 → 标 `stale` 并提示重新生成。**绝不覆盖**。
3. **新建 / 删除文件**：提案的 `path` 指向不存在的文件时走 `createFile`；删除通过 `op: "delete"` 表达（同样要先接受才落盘）。
4. **提案只在内存**：窗口重载后壳侧列表清空，内核若还在运行会重新广播 `proposal.changed`；内核不在了就什么都没了（检查点仍然可以整轮回滚）。

### 11.4 为什么没有"逐函数"

曾经设计过"按函数分组、逐个 Keep/Undo"，评估后放弃，原因写在 [§14.10](#1410-为什么最终采用逐文件审批)。保留的扩展点：`ProposalDto` 可以后续加 `units?: FunctionUnit[]`，把"一个文件的提案"拆成多个子项——**协议不需要改结构，只是给 UI 多一个层级**。

### 11.5 与 git 及工作区状态的关系

- Agent **不自动 commit**，提交权 100% 留给用户。
- 提案**不写盘**，所以"拒绝"在 `git status` 里不留任何痕迹。
- ⚠️ **不要承诺多文件原子性**：文件系统没有跨文件事务。"全部接受"是逐个文件写入，中途失败就停在那个文件并如实报告——不会出现"一半写了一半没写却没提示"。
- 会话结束时仍有待审提案：默认**保留**并提示（可在面板里继续接受/拒绝）。

### 11.6 右侧轨迹与任务成本（已实现）

面板右侧是一列**会话轨迹**：每一轮一条，显示意图分析给出的 `intent` 与模式图标。
点击任意一条会平滑滚动到对应的用户消息并短暂高亮——长会话不必再翻历史。

- 数据来自 `turns.jsonl` 的 `{intent, mode, userMessageId}`；
- 新轮次在 `ui.intent` 到达时即时追加（不必等轮次结束）；
- 重载/切换会话/聊天回滚后由 `refreshTrajectory()` 重建；
- 顶部 header 同时显示**任务级成本**：本轮累计 token、耗时；超过预算 80% 显示「⚠ 接近预算」；
- 每轮成本（token / 耗时）写入 turn record；`会话 → 选择历史会话` 的列表里显示会话累计成本，
  右侧轨迹每条也带本轮成本（`12.3k tok · 8.4s`）；
- 轨迹顶部有搜索框：按意图文本过滤（大小写无关），长会话里可以只看"重构"相关；
- 三种模式用不同颜色区分：Chat 蓝、Builder 绿、Debugger 红（圆点与左侧色条同步）。

### 11.7 子代理的可视化（已实现）


子代理的过程不推流（避免把主对话刷满），而是在面板里渲染成**一张可折叠卡片**：

```
◈ 查一下 parseConfig 在哪里定义            探索中
  ◌ read_file   src/config.ts            ← 运行中
  ✓ read_file   src/config.ts            ← 完成
  ✓ search_code parseConfig              ← 完成
  ─────────────────────────────────────
  完成 · 2 步 · 3 次工具调用
  ┌ 结论（可滚动，≤2000 字符）──────────┐
  │ parseConfig 定义在 src/config.ts:12 │
  └────────────────────────────────────┘
```

数据链路：内核 `ui.subagent` 通知（`start` / `tool` / `end`）→ 壳转发给 webview
→ `panel.js` 按 `id` 聚合，同一个子代理的多次事件更新同一张卡。

设计要点：

- **默认展开**：用户想看过程；完成后可以手动折叠
- **失败自动展开**：`end` 带 `error` 时卡片保持展开并显示原因
- **id 聚合**：同一轮可能有多个子代理并行（未来），卡片互不干扰
- **只显示工具流水与结论**：子代理的思考文本不进面板，避免两套推理混在一起

---
## 12. 安全与隐私

### 12.1 密钥

- 解析顺序：`SecretStorage` → 环境变量 `BEE_CODE_API_KEY` → 报错；只存 `SecretStorage`（环境变量是兜底，不是替代），见 [§5.3](#53-密钥存储)。
- **传给内核时只走一次握手**：`apiKey` 通过 Python 子进程的 **stdin** 作为 `initialize` 参数传入，**不放 argv**（`ps` 全机可见）、**不放环境变量**（同用户可读、容易被 `env` 或崩溃转储带进日志）。内核只在内存持有，不落盘。
- 所有日志走 `redact()`（`src/log.ts`），共 6 条规则：`sk-` 家族、十余种厂商前缀（`gsk_`/`hf_`/`ghp_`/`gho_`/`ghs_`/`github_pat_`/`xox[baprs]-`/`AIza`/`ya29.`/`sk_live_`/`rk_live_`）、AWS `AKIA`/`ASIA`、`Bearer` 头、URL 查询参数（含 `signature`）、JSON/配置字段。每条规则**保留前缀**，日志仍能看出"这里本来有个 token"。
- **内核 stderr 也过同一条脱敏管道**（`coreStderr()`）：否则 Python 把带 `?api_key=` 的 traceback 打进面板，就等于开了个绕过通道。
- 诊断包（见 [§12.1.1](#1211-日志脱敏与诊断包已实现)）默认剔除：prompt 全文、文件内容、密钥、完整工作区路径、内网 URL。
- 明确声明：**扩展没有后端**，请求直达用户配置的 `base_url`；不接入任何遥测（或首次启动显式询问，默认关）。

### 12.1.1 日志脱敏与诊断包（已实现）

**两个 `LogOutputChannel`**（`createOutputChannel(name, { log: true })`）：`Bee Code` 主日志、`Bee Code · 内核 stderr`。分开的理由是 Python traceback 又长又带行号，混进主日志会把"这一次请求发生了什么"彻底淹没。

用 log channel 而不是普通 `OutputChannel`，换来三件事：

| 能力 | 说明 |
| --- | --- |
| **落盘** | 内容写进 VS Code 的日志文件（`Developer: Open Logs Folder` 可找到），**扩展崩溃后仍可查** —— 这是"诊断包"覆盖不到的场景（诊断包要用户手动导出，崩了就没机会了） |
| **级别可调** | 用户在输出面板下拉里选 Trace/Debug/Info…，不用改代码。默认级别是 info，所以 `debug()` 默认被过滤（启动期那行"已注册 RPC 方法"因此提到 info 级） |
| **统一格式** | 时间戳与级别前缀由 VS Code 添加，`log.ts` 不再手拼 |

**内存有界队列**：`Logger` 额外保留最近 **500 行**（主日志与 stderr 各一份）。原因是 log channel 的内容**同样只写不读**——想导出"刚刚发生了什么"必须自己留一份。严格说这是"有界队列/滑动窗口"（容量恒定、溢出丢最旧，但用 `splice` 搬移），不是教科书意义的环形缓冲；500 行的搬移成本可忽略，换来的是代码可读性。

**内核 stderr 按行缓冲 + 分级**：stderr 是流式 chunk（可能是半行），所以先攒到 `\n` 再作为一条日志写出，`dispose()` 时冲刷残余；命中 `Traceback (most recent call last)` / `XxxError:` 的行用 error 级，其余用 info 级。这样 traceback 既落盘、又在日志里显眼，并且**同样过 `redact()`**。

**导出命令**：`Bee Code: 导出诊断包（已脱敏）`

| 项 | 值 |
| --- | --- |
| 落点 | `<globalStorage>/diagnostics/bee-code-diagnostics-<YYYYMMDD-HHmmss>.md` |
| 格式 | 单个 Markdown（可直接贴进 GitHub Issue；不引 zip 依赖） |
| 后续动作 | 生成后弹提示，可选「打开所在文件夹」或「另存为…」（`showSaveDialog`，默认目录 `os.homedir()`） |
| 为什么落在扩展私有目录 | 一定可写、不进 git、不污染用户工作区；用户要分享时再另存 |

诊断包包含：环境（扩展/VS Code/平台/Node/Electron/内存/内核模式/Python 解释器 basename）、配置（**baseUrl 只保留 origin**，路径与查询参数全部丢弃）、主日志、内核 stderr、以及一段「明确未包含」的隐私声明。

四个硬约束（都写在 `src/diagnostics.ts` 顶部）：

1. **不读 `SecretStorage`**——文件里根本不存在密钥，不依赖脱敏兜底；
2. **baseUrl 只留 `protocol://host`**——避免 `?api_key=` 与内网路径泄漏；
3. **工作区只留文件夹名**——不写入用户名与目录层级；
4. **整份文档最后再过一遍 `redact()`**——兜底。

### 12.2 工作区信任（Workspace Trust）

- 声明 `capabilities.untrustedWorkspaces.supported: "limited"`：受限模式下禁用 `run_command`/`run_test`，只读工具 + 写入待审仍可用，但写入门闸全部强制打开。
- 打开不受信任工作区时，在面板顶部显示警示条。

### 12.3 文件访问边界

- 所有路径 `path.resolve` 后必须 `startsWith(workspaceRoot)`，拒绝 `..` 穿越与符号链接逃逸。
- 默认拒绝写入：`.git/**`、`node_modules/**`、`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.beecode/secrets*`。
- 读取大文件：> 512KB 走流式按行读（不再整体拒绝）；单次返回上限 256KB / 2000 行，超出标 `truncated`。
- 忽略规则三层合并：内置默认 → `.gitignore` → 用户 `beeCode.files.exclude`。

### 12.4 命令执行（已实现，默认拒绝）

`run` RPC 已落地，默认**不可用**——`permissions.mode: manual` 下每条命令都要确认，`plan` 模式直接拒绝。

六条硬约束（缺一不可）：

| 约束 | 实现 |
| --- | --- |
| cwd 必须在工作区内 | `resolveCwd` + `isInside` |
| 环境变量清洗 | 剔除 `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`*AUTH*`（防止把密钥递给子进程） |
| 超时 + 整棵进程树 | Windows `taskkill /T /F`；POSIX `kill(-pid, SIGKILL)` |
| 输出限幅 | stdout/stderr 各 64KB，超出标 `truncated` |
| 非交互 | stdin 立即关闭（否则 git 之类会卡住等输入） |
| 权限判定 | deny → ask → allow → 模式默认；`ask` 时弹确认（可"记住这条命令"） |

沙箱见 [§12.5](#125-权限规则信任与沙箱已实现)。宿主机隔离（容器 / OS 沙箱）是「真隔离」与「假隔离」的分水岭。

### 12.5 权限规则、信任与沙箱（已实现）

```
权限模式（plan/manual/acceptEdits/auto/bypass）
   └─ 规则（allow / ask / deny，按工具 + 参数匹配）
        └─ 工作区信任（不受信任 → 禁写、禁命令）
             └─ 沙箱（off / docker；命令执行的隔离级别）
```

#### 12.5.1 规则语法与求值顺序

```
Read(src/**)        读：路径 glob
Edit(src/**)        写/删：路径 glob（`Write` 是别名）
Run(npm test *)     命令：`*` 结尾 = 前缀匹配；否则精确匹配
```

求值顺序固定：**deny → ask → allow → 模式默认**。deny 永远优先，allow 不能从 deny 里挖例外。

实现是纯函数（`src/permissions.ts`），**壳侧求值**；内核只读规则用于提示模型，不参与判定。

#### 12.5.2 权限模式

| 模式 | 读 | 写 | 命令 |
| --- | --- | --- | --- |
| `plan` | ✅ | ❌ | ❌ |
| `manual`（默认） | ✅ | 需要确认 | 需要确认 |
| `acceptEdits` | ✅ | ✅（提案仍需用户点接受） | 需要确认 |
| `auto` | ✅ | ✅ | 需要确认（暂无可靠的"低风险"判定） |
| `bypass` | ✅ | ✅ | ✅（只应在容器/VM 里用） |

`allow` 规则可突破模式默认（例如 plan 模式下允许 `Run(npm test *)`）。

#### 12.5.3 工作区信任

- VS Code 的 `workspace.isTrusted` 是硬前提；
- 另外**自己记一份**（`globalState`），首次打开问一次「信任 / 只读」；
- 不受信任时：**只允许读**，写与命令一律 `DENIED(-32013)`，与规则无关；
- 命令「信任/取消信任此工作区」可随时切换。

#### 12.5.4 沙箱三档

| 档 | 做法 | 强度 | 状态 |
| --- | --- | --- | --- |
| **L1 策略** | §12.4 的六条 | 弱（防手滑，不防恶意） | ✅ |
| **L2 进程** | L1 + 无网 + 资源限制 + 只读系统目录 | 中 | ⬜ 平台 API 各自实现，暂缓 |
| **L3 容器** | `docker run --network none --read-only --cap-drop ALL --memory 2g --pids-limit 256 --security-opt no-new-privileges` | 强 | ✅（`sandbox: docker/auto`） |

**没有 L3 时不要把命令执行交给 `auto`/`bypass`**。

#### 12.5.5 有效策略表（按 docker / 角色 / 位置判定）

| 条件 | 主代理 | 子代理 |
| --- | --- | --- |
| 工作区未受信任 | 只读（工作区内） | 只读（工作区内） |
| 工作区外路径（读/写/执行） | **需审批** | **拒绝** |
| 有 docker：执行命令 | 需审批（`fullAccess` 时免）；**强制在容器内** | 允许（容器内） |
| 有 docker：写文件 | 按规则/模式 | 需审批（`fullAccess` 时免） |
| 无 docker：执行命令 | **每次都审批**（不给"记住"） | 仅允许只读命令，其余拒绝 |
| 无 docker：写文件 | 按规则/模式 | **拒绝** |

`fullAccess` 只免审批，**不**解除"未受信任只读"和"工作区外需审批"。

启动时的 docker 检测（避免反复打扰）：

| 情况 | 行为 |
| --- | --- |
| 检测到 docker | 每次启动提示一次「已检测到 Docker，命令将在沙箱内执行」 |
| 没检测到（首次 / 配置变化） | 弹窗问「有 Docker 吗」：有 → 重新检测；没有 → 记录并静默；稍后 → 下次再问 |
| 没检测到（已问过） | **静默**，按无沙箱策略运行 |
| 装好 Docker 之后 | 命令「重新检测 Docker 沙箱」，无需重启窗口 |
#### 12.5.6 子代理（已实现）

```
主 agent ── spawn_subagent(task, max_steps?) ──▶ 子 agent（独立上下文，8 个只读工具）
                                                      │
                                                 需要执行 → run（沙箱内）
                                                      ▼
                                          结论 + path:line 引用（≤8KB，不回传 transcript）
```

落地方式：

| 项 | 实现 |
| --- | --- |
| 工具 | `spawn_subagent(task, max_steps?)`，只在**主代理**的工具集里 |
| 子代理工具集 | 8 个只读工具（无 `propose_edit`、无 `spawn_subagent`）→ **不能无限嵌套** |
| 上下文 | 独立 `Session`，只把 ≤8KB 的结论回传主代理 |
| 角色 | 子代理的 `ShellClient` 带 `role: "subagent"`，壳侧策略自动收紧（§12.5.5） |
| 步数 | 默认 8、上限 12；父轮次 `abort` 会级联取消子代理 |
| 输出 | 子代理不往 UI 推流（避免刷屏），只在内核日志留痕 |

`run` 返回的 `exitCode/stdout/stderr` 就是"沙箱内验证回路"的原料：测试/构建结果回灌模型，由它决定下一步。

#### 12.5.7 子代理的独立模型配置（已实现）

用户可以让子代理用**另一套端点/模型/密钥**（例如主代理用强模型，子代理用便宜的快模型）：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `beeCode.subagent.enabled` | `true` | 关闭后主代理没有 `spawn_subagent` 工具 |
| `beeCode.subagent.baseUrl` | 空 = 沿用主代理 | machine 作用域（工作区不能覆盖） |
| `beeCode.subagent.model` | 空 = 沿用主代理 | 建议填便宜/快的模型 |
| `beeCode.subagent.apiKeyId` | `beeCode.apiKey.subagent` | SecretStorage 键名 |
| `beeCode.subagent.maxSteps` | `8` | 上限 12 |
| `beeCode.subagent.supportsVision` | `auto` | 子代理的视觉能力（`auto` = 先试，被拒后自愈） |

密钥解析顺序：`SecretStorage` → 环境变量 `BEE_CODE_SUBAGENT_API_KEY` → **主代理密钥**。

命令（与主代理同一套交互）：

- `Bee Code: 配置子代理模型`（三步向导；端点/模型留空 = 沿用主代理，密钥留空 = 沿用主代理密钥）
- `Bee Code: 测试子代理连接`
- `Bee Code: 清除子代理 API Key`

密钥仍然**只经 stdin 的 `initialize` / `model.reload` 传给内核**，不落 settings、不进日志。

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

### 14.9 我们与工业界的对照

| 维度 | 工业常见 | 本项目 |
| --- | --- | --- |
| 写入时机 | Copilot 本地 harness：直接写 + pending；Cline/Claude Code：先看 diff 再决定 | **先看 diff 再决定**（提案模式），资产零风险 |
| 审阅粒度 | 按文件（Copilot/Cursor/Cline）或按 `LineChange` | **按文件**（扩展点：将来可加函数子项） |
| 回滚底座 | Cline 影子 git / Claude Code checkpoint + `/rewind` | **相同**：影子 git + Restore |
| 事前门闸 | Claude Code 的权限规则、Codex 的 sandbox/approvals | 写入门闸（§10.7）+ 路径策略（§12.3） |

一句话：**在「先审后写」这条线上与 Cline / Claude Code 同向，在「按什么粒度审」上选最稳的那一档 —— 文件。**
### 14.10 为什么最终采用逐文件审批（提案模式）

这个决策来回改过两次，最终形态是**提案 + 逐文件接受**：

| 版本 | 形态 | 为什么放弃 |
| --- | --- | --- |
| v0.1 之前 | Overlay 沙箱 → 逐函数审批 → 落地 | 自建虚拟文件系统与预览，工程量大；与原生 undo/diff 割裂 |
| v0.1 | 直接写盘 → 逐函数 `Keep`/`Undo` | 对齐了 Copilot/Cursor，但**用户反馈**"不接受就落盘"心智不直观；逐函数切分在跨函数改动时会产生编译不过的中间态 |
| **v0.3（现在）** | **提案（虚拟文件）→ 逐文件接受 → 落盘** | 见下 |

为什么它是对的：

1. **审批语义清晰**：不接受 = 磁盘零改动。没有"Keep 不是 Save"的歧义，也不需要向用户解释"文件已经保存了"。
2. **粒度选在文件**：文件是"用户能一眼判断的最小完整单位"，也是一个原子的写入单元（`WorkspaceEdit` 一次替换）。函数级会切出"半截重构"，文件级不会。
3. **与工业界不冲突**：VS Code 本地 harness 的 pending 语义、Cline 的影子 git `Compare`/`Restore`、Claude Code 的 `/rewind`，本质都是"先看 diff 再决定"，只是承诺发生的时间点不同。
4. **实现反而更省**：预览 = 一个虚拟文档 + `vscode.diff`；不需要维护 QuickDiff 的 `LineChange` 映射，也不需要倒序 undo 的错位处理。

代价（认了）：

| 代价 | 缓解 |
| --- | --- |
| 提案只在内存，重载即丢 | 内核重新广播；整轮回滚仍可靠检查点（[§10.5](#105-检查点checkpoint回滚的地基)） |
| 大文件全文经 JSON-RPC 传输 | 按需 `proposal.read`（不进通知）；`diffAdapter` 有 LRU 上限 |
| 逐文件粒度较粗 | 保留 `ProposalDto.units` 扩展点，将来可展开到函数级 |

**从"写盘 + Keep/Undo"保留下来的一件事**：检查点（影子 git）。即使用户已经接受了一堆提案，仍然可以整体 `Restore` 回去——审批解决"要不要写入"，检查点解决"写错了怎么整体退"。
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
