# Code Agent for VS Code

> 一个「自带模型」（BYO-Model）的通用代码智能体 VS Code 扩展：**Chat / Builder / Debugger** 三模式协作，
> 统一走 **OpenAI 兼容协议**，所有代码改动先进 **沙箱**，再以 **红绿 diff + 逐函数审批** 的方式落到工作区。

![status](https://img.shields.io/badge/status-design--phase-orange)
![vscode](https://img.shields.io/badge/vscode-%5E1.104-blue)
![license](https://img.shields.io/badge/license-Apache--2.0-green)

---

## 目录

- [0. 文档说明](#0-文档说明)
- [1. 项目定位](#1-项目定位)
- [2. 设计原则](#2-设计原则)
- [3. 术语表](#3-术语表)
- [4. 总体架构](#4-总体架构)
- [5. 模型接入层（OpenAI 兼容）](#5-模型接入层openai-兼容)
- [6. 三模式设计](#6-三模式设计)
- [7. Agent 内核与循环](#7-agent-内核与循环)
- [8. 工作区感知与上下文工程](#8-工作区感知与上下文工程)
- [9. 选区快捷入口](#9-选区快捷入口)
- [10. 沙箱改动（Sandbox Staging）](#10-沙箱改动sandbox-staging)
- [11. 变更预览与逐函数审批](#11-变更预览与逐函数审批)
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
- 命名是暂定值（仓库名 `code-agent`，扩展 ID `<publisher>.code-agent`，命令前缀 `codeAgent.`），定名后可全局替换。

---

## 1. 项目定位

### 1.1 一句话

把「一个能读懂你整个工程、能解释、能写、能修的 AI 结对程序员」装进 VS Code，并且**模型完全由用户自带**、**改动永远先给你看**。

### 1.2 要解决的问题

| 痛点 | 本项目的回答 |
| --- | --- |
| 云端订阅模型的绑定：只能用厂商自带的模型/订阅 | 用户自己填 `model` / `api_key` / `base_url`，任意 OpenAI 兼容端点（官方、DeepSeek、Qwen、Kimi、GLM、OpenRouter、Ollama、vLLM、one-api 网关…） |
| 一个模型提示词打天下：解释、生成、修 bug 用同一套 prompt，效果都不极致 | 三模式独立提示词 + 独立工具集 + 独立的「允许做什么」约束 |
| AI 直接改文件，改坏了才发现 | 所有写入先进 **内存 Overlay 沙箱**，产出 `ChangeSet`，**逐函数审批**后才落地 |
| AI 看不到「跟你这个问题相关」的代码 | 三级检索：文件清单 → 关键词/符号检索 → 工具驱动的按需精读 |
| 想改一段代码要先复制粘贴到聊天框 | 选中即问：右键 / 快捷键直接进 Chat、Builder、Debugger |
| 不知道 AI 到底动了哪些文件 | Multi-Diff 预览：删除标红、新增标绿，按「函数」分组，可单条接受、可一键接受 |

### 1.3 非目标（v1 明确不做）

- ❌ 不做托管后端、不中转用户请求、不收集代码（**没有服务器**，密钥与代码只在本机与用户指定的模型端点之间流动）。
- ❌ 不做完整的 IDE 替代（不接管补全、不实现完整的 LSP）。
- ❌ 不做无审批的全自动「无人值守 / YOLO」模式（可作为 🧪 高级开关，默认关闭且需显式二次确认）。
- ❌ 不追求一次支持全语言；首期聚焦 TS/JS/Python/Go/Java/Rust 这些有成熟 LSP symbol 能力的语言。

---

## 2. 设计原则

1. **零信任改动（Change is a proposal, not a write）**：模型只能产出「改动提案」，永远拿不到直接写文件的句柄。
2. **用户主权（User holds the keys）**：API Key 进 `SecretStorage`（OS 级加密凭据库），不进 `settings.json`、不进日志、不进 git。
3. **协议统一（One wire format）**：内部只有一种模型协议 —— OpenAI Chat Completions 兼容格式；异构厂商差异在适配层吃掉。
4. **可解释（Every step is visible）**：每一次工具调用、每一次检索命中、每一次 token 花费都可在面板里回放。
5. **可中断（Always cancellable）**：任何时刻一行 `AbortSignal` 就能停下循环，不产生半截写入。
6. **内核与 UI 解耦**：`src/core` 是纯 TypeScript，不 import `vscode`，可脱离编辑器单测、复用到 CLI / Web。

---

## 3. 术语表

| 术语 | 含义 |
| --- | --- |
| **Mode（模式）** | Chat / Builder / Debugger，决定提示词、可用工具集、输出契约 |
| **Agent Loop（智能体循环）** | `组装上下文 → 调模型 → 解析工具调用 → 执行工具 → 回填结果 → 再调模型` 的迭代过程 |
| **Tool（工具）** | 暴露给模型的可调用函数，JSON Schema 描述参数，分只读 / 写 / 执行三类 |
| **Sandbox FS（沙箱文件系统）** | 内存 Overlay：读操作回落到真实工作区，写操作只写入 overlay |
| **ChangeSet（改动集）** | 一次任务产出的全部拟改动：文件 → hunk → 函数路径的结构化集合 |
| **Hunk（变更块）** | 统一 diff 中一个 `@@ ... @@` 块，是「逐条审批」的最小可操作单元之一 |
| **Function Unit（函数单元）** | 把若干 hunk 归并到其所属函数/方法后形成的审批分组（默认审批粒度） |
| **Context Budget（上下文预算）** | 按比例分配给系统提示词、检索、历史、输出的 token 配额 |

---

## 4. 总体架构

### 4.1 分层

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L1  UI 层（VS Code 原生 + Webview）                                       │
│  Chat/Agent 面板 · 选区右键菜单 · 快捷键 · 文件选择器(QuickPick/Tree)      │
│  变更预览（Multi-Diff Editor） · 函数级审批卡片 · 状态栏(token/费用/停止)   │
├──────────────────────────────────────────────────────────────────────────┤
│ L2  扩展宿主适配层（Extension Host, Node.js）—— 只做「VS Code 世界的事」    │
│  Command 注册 · 会话/工作区生命周期 · SecretStorage · workspace.fs         │
│  DocumentSymbol 查询 · Diff/Decoration 渲染 · WorkspaceEdit 落地           │
├──────────────────────────────────────────────────────────────────────────┤
│ L3  Agent 内核（@core，纯 TS，无 vscode 依赖，可单测/可复用）                │
│  AgentLoop · ModeRouter · PromptComposer · ContextEngine · ToolRegistry   │
│  SandboxFS · ChangeSetBuilder · ReviewPlanner · Guard(预算/死循环)         │
│  SessionStore · EventBus                                                   │
├──────────────────────────────────────────────────────────────────────────┤
│ L4  出站适配层（Providers）                                                │
│  LLMClient: OpenAI 兼容（chat.completions + tools + stream）              │
│  Tools: 工作区读写代理 / 检索 / 诊断 / 后续的命令执行                       │
│  MCPClient: stdio + Streamable HTTP · SkillLoader                          │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键约束**：依赖只能自上而下。L3 不允许 `import * as vscode from 'vscode'`（用 ESLint `no-restricted-imports` 强制），所有编辑器能力通过 L2 注入的接口（`WorkspacePort`、`DiffPort`、`SecretPort`…）访问。这是 Cline / Continue 这类项目都在用的「内核与宿主解耦」做法，好处是可以在纯 Node 环境里跑回归测试、也能把同一内核接到 CLI。

### 4.2 一次 Builder 请求的完整时序

```
用户: 在 a.ts 里选中 parseConfig()，按 Ctrl+Alt+B，输入「改成支持 .yaml 配置」
  │
  ├─(1) L2 采集「显式上下文」：选区文本 + 文件路径 + 光标位置 + 相邻 120 行
  ├─(2) L2 采集「环境事实」：workspace root / 语言 / package.json 摘要 / git 分支 / 诊断
  ├─(3) L3 ModeRouter 装配 system prompt（builder.md 覆盖层）+ 工具集（读 + propose_*）
  ├─(4) L3 ContextEngine 生成「候选上下文包」：
  │        · 文件清单（Git-aware，忽略 node_modules/.git/dist）
  │        · ripgrep 关键词命中（parseConfig / yaml / config 相关）
  │        · 符号索引命中（同名函数、调用点）
  │        压缩到 token 预算内后作为首轮 messages
  ├─(5) LLMClient 流式请求（tools 声明）→ 模型返回 tool_calls: read_file / search_code
  ├─(6) ToolRegistry 执行只读工具 → 结果回填 → 循环（最多 maxSteps）
  └─(7) 模型调用 propose_patch（只写 SandboxFS）
         │
         ├─ L3 ChangeSetBuilder: patch → 按文件解析 hunk → 查 DocumentSymbol 归属函数
         ├─ L3 ReviewPlanner: 排序分组（函数单元），生成审批计划
         ├─ L2 渲染: 打开 Multi-Diff 预览（红删/绿增），面板列出「函数 N 个 / hunk M 个」
         └─ 用户: 逐条勾选或「一键全部接受」
                └─ L2 冲突检测（文件是否被改动）→ WorkspaceEdit 原子应用 → 可撤销
```

### 4.3 模块职责

| 模块 | 层 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| `ui/*` | L1 | 渲染会话、审批卡片、diff 导航 | 不拼提示词、不解析模型输出 |
| `vscode/ports/*` | L2 | 把 VS Code API 包成端口接口（fs / symbols / secrets / diff / window） | 不含业务规则 |
| `core/loop` | L3 | 驱动循环、状态机、取消、事件广播 | 不关心渲染 |
| `core/modes` | L3 | 模式定义、能力矩阵、模式切换 | 不直接读文件 |
| `core/prompts` | L3 | 提示词模板装配（base + overlay + memory + tools） | 不含厂商差异 |
| `core/llm` | L3/L4 | OpenAI 兼容客户端、流式解析、重试、用量统计 | 不选模型 |
| `core/context` | L3 | 文件索引、检索、预算分配、压缩 | 不发起网络请求 |
| `core/tools` | L3 | 工具注册表、schema、参数校验、权限声明 | 不直接碰磁盘 |
| `core/sandbox` | L3 | Overlay 文件系统、快照、冲突基线 | 不写真实文件 |
| `core/changeset` | L3 | patch 解析、hunk/函数归并、审批计划、序列化 | 不渲染 UI |
| `core/guard` | L3 | 步数/预算/重复/无进展检测、熔断 | 不做审批决策 |

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
| **运行进程** | 代码跑在 **Extension Host**（独立 Node.js 进程），不能碰 DOM；所有编辑器能力必须通过 `vscode` 模块的 API，UI 自定义只能靠 Webview |
| **打包发布** | `npx @vscode/vsce package` 产出 `.vsix`；上架需要 Marketplace publisher + Azure DevOps PAT，`README.md` 会成为商店详情页正文，`icon` ≥ 128×128 |
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
| 配置项 | `contributes.configuration` + `workspace.getConfiguration('codeAgent')` |
| 状态栏（token/停止） | `window.createStatusBarItem()` |
| 日志与排障 | `window.createOutputChannel('Code Agent')`（注意脱敏） |
| MCP 工具互操作（可选） | `contributes.mcpServerDefinitionProviders` + `lm.registerMcpServerDefinitionProvider()` |
| 原生命令/斜杠命令集成（可选） | `contributes.commands` + `menus.commandPalette`；聊天侧可另注册 Chat Participant |

#### 4.4.3 三条「要不要用官方 AI API」的技术路线

| 路线 | 能拿到什么 | 限制 | 本项目取舍 |
| --- | --- | --- | --- |
| **Chat Participant API**（`contributes.chatParticipants` + `vscode.chat`） | 直接长在 VS Code 原生 Chat 里：`@participant`、`/slash`、`#context`、原生工具审批 UI、历史记录 | 交互流程被 `ChatRequestHandler` 框住，UI 不可自定义；模型来自 VS Code 已注册的模型 | ❌ 不作为主界面（我们要自定义审批/预览 UI） |
| **Language Model API**（`vscode.lm.selectChatModels`） | 调用编辑器里可用的模型，`LanguageModelChatMessage` + `lm.registerTool` 原生工具调用 | **只能选已注册的模型**，无法指定 `base_url` 与用户自己的 key | ❌ 与「BYO 端点」冲突 |
| **自建 HTTP 客户端 + Webview 面板** | 任意 OpenAI 兼容端点、任意 UI、完全掌控循环与审批 | 全部自己实现（流式、工具调用、重试、渲染） | ✅ **v1 主线** |

> 🧪 加分项（不冲突）：后续实现 `LanguageModelChatProvider`，把用户自带的端点**注册成 VS Code 的一个模型**，这样在 Copilot Chat 里也能选到「我的 DeepSeek」。这属于「反哺平台」，不改变主架构。

#### 4.4.4 Webview 的安全红线

- 所有资源走 `asWebviewUri`，`localResourceRoots` 限制到 `dist/webview` 目录。
- CSP 严格：`default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`。
- 消息通道双向校验：`onDidReceiveMessage` 里对 `type` 做白名单，**不信任**前端传来的路径（前端可被注入）。
- `retainContextWhenHidden` 默认关（它会让隐藏的 webview 一直吃内存），用「状态序列化 + 恢复」代替。

---

## 5. 模型接入层（OpenAI 兼容）

### 5.1 为什么统一成 OpenAI 格式

- 事实标准：`POST {base_url}/chat/completions`、`messages[]`、`tools[]`/`tool_calls`、SSE 流式增量，几乎所有国内外厂商都提供兼容层（DeepSeek、Qwen/DashScope compatible-mode、Kimi、GLM、OpenRouter、Ollama、vLLM、LM Studio、one-api/new-api…）。
- 只维护一套客户端 = 只维护一份工具调用解析、一份流式状态机、一份用量统计。
- 用户「自带端点」是最高优先级需求：只要他有一个能跑 `curl` 的兼容端点，扩展就能用。

> 与 VS Code 官方 `vscode.lm`（Language Model API）的关系：官方 API 只能选「编辑器里已注册的模型」（典型是 Copilot 提供的模型），**无法指定任意 `base_url` 与用户自己的 key**。因此本项目自建 HTTP 客户端，不依赖 `vscode.lm`。🔬 后续可选：同时注册 `LanguageModelChatProvider`，把我们的 BYO 端点反哺给 VS Code 原生 Chat，属于加分项，见 [§14](#14-工业界参考)。

### 5.2 用户配置项

设置项写在 `settings.json`（**可进 git 的部分只有这些，没有密钥**）：

```jsonc
{
  "codeAgent.model": {
    "baseUrl": "https://api.deepseek.com/v1", // 不含 /chat/completions
    "model": "deepseek-chat",
    "apiKeyId": "codeAgent.apiKey.default",   // 指向 SecretStorage 的键名，不是密钥本身
    "temperature": 0.2,
    "maxOutputTokens": 8192,
    "stream": true,
    "supportsTools": true,                    // 能否原生 function calling
    "supportsVision": false
  },
  "codeAgent.agent": {
    "maxSteps": 30,
    "maxTokensPerTask": 400000,
    "toolTimeoutMs": 30000,
    "defaultMode": "chat"
  },
  "codeAgent.review": {
    "granularity": "function",                // function | hunk | file
    "openDiffOnProposal": true,
    "requireApprovalForEveryHunk": false
  }
}
```

首次使用走「设置向导」（`codeAgent.model.configure` 命令）：

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

### 5.4 请求与响应约定

```ts
// core/llm/types.ts
interface ChatRequest {
  model: string;                       // 来自设置
  messages: ChatMessage[];              // system | user | assistant | tool
  tools?: ToolSpec[];                   // JSON Schema
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];              // assistant 侧
  tool_call_id?: string;                // tool 侧
  name?: string;
}
```

- **流式**：解析 SSE `data: {...}`，累积 `delta.tool_calls[i].function.arguments` 片段，按 `index` 归并（这是各厂商最容易出差异的地方，需要容错：有的厂商不给 `index`，有的把 `arguments` 一次性给完）。
- **首包/超时**：连接超时 15s，首 token 超时 90s，空闲超时 60s；`AbortController` 与 UI 的「停止」按钮联动。
- **用量**：优先读 `usage`；没有则用 `js-tiktoken` 估算并标注「估算值」。

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

**工具调用降级方案**（`supportsTools: false` 时）：提示词里给出严格 JSON 输出协议，模型输出 ```json {"tool": "...", "args": {...}}``` 代码块，内核解析成「伪 tool_call」后照常执行，失败重试带上「上一次格式错误」的纠正提示。这样连最朴素的本地模型也能跑 Builder。

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
| 工具集 | 只读（`list_files` / `read_file` / `search_code` / `file_outline` / `get_diagnostics`） | 只读 + `propose_*`（写沙箱） | 只读 + `propose_*` + 🧪`run_command`/`run_test` |
| 是否允许改文件 | ❌ 硬性禁止（工具列表里根本没有写工具） | ✅ 仅沙箱 | ✅ 仅沙箱 |
| 输出契约 | 自然语言 + `file:line` 引用 + 可选 Mermaid 图 | 改动提案 + 变更说明 + 影响分析 | 根因 → 证据 → 修复提案 → 验证方式 |
| 默认温度 | 0.3 | 0.5 | 0.2（求确定性） |
| 典型触发 | 选中代码 `Ctrl+Alt+K`、`@chat` | 选中代码 `Ctrl+Alt+B`、`/build` | 选中代码 `Ctrl+Alt+D`、诊断右键「用 Debugger 修」 |
| 结束条件 | 给出回答（可不调用工具） | 产出至少一个 ChangeSet 或明确「无法完成」 | 产出 ChangeSet + 验证结论 |

> 模式隔离的工程要点：Chat 模式**不要**在 `tools[]` 里声明写工具再靠提示词禁止 —— 提示词是可以被绕过的，正确的做法是「模型根本看不见这个工具」。这是权限最小化（least privilege）在 Agent 上的直接体现。

### 6.2 提示词结构

```
system =
  ┌ BASE（三模式共享） ────────────────────────────────
  │ 角色定位 / 可用工具与使用纪律 / 输出格式约定
  │ 安全红线（不写密钥、不臆造 API、不确定就说不知道）
  │ 环境事实（workspace 名、根路径、语言、git 分支、时间）
  │ 项目规则（AGENTS.md / .codeagent/rules/*.md 注入）
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
3. 再动笔：用 propose_patch 提交改动，一次一个文件，patch 用标准 unified diff。
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
4. 修复：propose_patch 给出最小修复，并在说明里写「为什么这样改能消除根因，而不只是消除症状」。
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
// core/loop/AgentLoop.ts（示意）
async function* run(session: Session, input: UserTurn): AsyncGenerator<LoopEvent> {
  const guard = new Guard(session.budget);
  let step = 0;
  while (true) {
    if (guard.shouldStop(step++)) return yield { type: 'stopped', reason: guard.reason };
    const messages = session.prompts.assemble(input);        // 预算裁剪后
    const stream = llm.streamChat({ messages, tools: session.mode.tools, stream: true });

    for await (const ev of stream) {
      if (ev.type === 'text') yield { type: 'delta', text: ev.text };
      if (ev.type === 'tool_call') yield { type: 'tool_start', ...ev };
    }
    const turn = await stream.done();
    session.history.push(turn);

    if (!turn.toolCalls?.length) return yield { type: 'final', text: turn.text };

    for (const call of turn.toolCalls) {
      const tool = registry.get(call.name);                  // 未注册 -> 回填错误，不崩
      const args = schema.parse(tool, call.args);            // 参数校验失败 -> 回填可读错误
      const result = await tool.run(args, session.ports);     // 只读立即执行；写工具落沙箱
      session.history.push({ role: 'tool', tool_call_id: call.id, content: result });
      yield { type: 'tool_end', call, result };
    }
  }
}
```

### 7.2 工具清单

| 工具 | 类型 | 主要参数 | 说明 |
| --- | --- | --- | --- |
| `list_files` | 只读 | `glob`, `maxDepth`, `includeIgnored?` | 返回工作区文件树（Git-aware） |
| `read_file` | 只读 | `path`, `startLine?`, `endLine?` | 分片读取，单次上限 400 行，超出提示分段 |
| `search_code` | 只读 | `query`, `regex?`, `glob?`, `contextLines?` | ripgrep 后端，返回 `路径:行:内容` |
| `file_outline` | 只读 | `path` | 符号大纲（函数/类/方法 + 行号区间） |
| `get_diagnostics` | 只读 | `path?`, `severity?` | 读 LSP 诊断（编译错误、lint） |
| `propose_patch` | 写（沙箱） | `path`, `patch(unified diff)`, `reason` | 唯一改文件入口；只写 SandboxFS |
| `propose_create` | 写（沙箱） | `path`, `content`, `reason` | 新建文件 |
| `propose_delete` | 写（沙箱） | `path`, `reason` | 删除文件（审批时默认需二次确认） |
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
| 无进展检测 | 连续 4 步没有新的文件被读取、没有新的 ChangeSet | 停止并询问用户「是否补充信息」 |
| 错误熔断 | 同一工具连续失败 3 次 | 禁用该工具本轮，回填「工具不可用，请改用 X」 |
| 单工具超时 | 30s（命令类可配） | 中止该工具，回填超时错误（不中断整个循环） |
| 用户中断 | 随时 | `AbortSignal` → 丢弃 sandbox 内容 → 保留已产出文本 |

> 设计要点：守卫要「先提醒、再停止」。直接硬停会让用户觉得模型「卡住了」；先插入一条系统提示纠正策略，往往能自愈。

---

## 8. 工作区感知与上下文工程

目标：**让模型在需要的时候看到正确的代码，而不是一次性塞进整个仓库。**

### 8.1 文件清单索引（人可选的「文件列表」）

需求里明确要「根据工作区内所有文件生成一个文件列表，让用户选择指定文件针对性阅读」。实现分三层：

| 层 | 机制 | 说明 |
| --- | --- | --- |
| 采集 | `vscode.workspace.findFiles('**/*', excludeGlob, 5000)` | 一次扫描拿全量路径；`exclude` 由三部分合成：内置默认（`**/node_modules/**`、`**/.git/**`、`**/dist/**`、`**/out/**`）+ `.gitignore` 解析（`ignore` 这个 npm 包，逐行匹配）+ 用户配置 `codeAgent.files.exclude` |
| 过滤 | 扩展名白名单 + 大小上限 + 二进制探测 | 二进制（前 8KB 含 NUL 字节）直接排除；> 512KB 只入索引不给内容 |
| 刷新 | `createFileSystemWatcher` 增量更新 | 新增/删除/重命名只更新索引条目，不全量重扫；`.gitignore` 变化时重建 |

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

- **不做**默认的向量索引：全量 embedding 有索引成本、陈旧问题和「把私钥/密钥文件也塞进向量库」的隐私风险；主流终端 Agent（Claude Code / Cline / Aider）都优先用「检索工具 + 模型自己决定读什么」的 agentic search。🧪 向量检索作为可选增强（本地 embedding 模型），默认关闭，见 [§14](#14-工业界参考) 的对比。
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
| 估算 token > 窗口 × 80% | ① 折叠工具结果：只保留命中行 ± 10 行，大块内容换成「已读 `path` L10-L200，摘要：…」；② 旧轮次摘要：由模型生成结构化摘要（**已确认事实 / 已读文件 / 已产生 ChangeSet / 未决问题**）；③ 保留「首轮任务描述 + 最近 3 轮原文」 |
| 用户点「压缩上下文」 | 立即执行 ②③，面板显示「压缩前 42k → 压缩后 9k」 |
| 新会话 | 从 `.codeagent/memory/notes.md` 与项目规则恢复长期记忆 |

记忆分三层（与工业界一致）：

1. **工作记忆**：当前会话 messages（内存 + `workspaceState` 落盘以便重启恢复）。
2. **会话摘要**：压缩产物，可回放。
3. **长期项目记忆**：`.codeagent/rules/*.md`（人类写的规则，随 git 提交）+ `.codeagent/memory/notes.md`（Agent/用户显式追加的事实，如「本仓库用 npm 不用 pnpm」「测试跑 `npm run test:unit`」）。同时兼容读取根目录 `AGENTS.md`。

> 记忆写入必须**显式**：模型想写记忆得调 `remember(note)` 工具并让用户确认，避免「模型自己给自己写规则」导致行为漂移。

### 8.5 新鲜度

- 每个文件缓存带 `mtime + hash`；`onDidChangeTextDocument` 时优先用编辑器内的**未保存**内容（用户经常改完没存就问）。
- 生成 ChangeSet 时记录基线 hash，落地前比对；不一致就标红「文件已被修改，请重新生成该文件」。

---

## 9. 选区快捷入口

### 9.1 交互

| 入口 | 行为 |
| --- | --- |
| 选中代码 → 右键 → `Code Agent: 解释 / 生成改动 / 排查` | 打开面板，把选区作为引用 chip 挂上，自动填入模式对应的默认指令 |
| 选中代码 → `Ctrl+Alt+K / B / D` | 同上，键盘直达（macOS 用 `Cmd+Alt+*`） |
| 无选区 → 快捷键 | 自动取「光标所在的整个函数」（用 DocumentSymbol 反查），再走上面的流程 |
| 诊断（红波浪线）→ 右键 `用 Debugger 修` | 带上诊断信息 + 所在函数进 Debugger |
| 终端选中输出 → 右键 | 作为「报错上下文」进 Debugger（v1.1） |

### 9.2 实现要点

1. **声明**：`contributes.menus.editor/context` + `contributes.keybindings`，两者都用 `when: "editorHasSelection"` 控制（无选区时菜单隐藏）；`group: "codeAgent@n"` 保证排序在同一组内。
2. **采集**：`vscode.window.activeTextEditor` → `selection`（支持多选区：逐个取，合并去重）→ `document.getText(range)`；同时记录 `uri`、`range.start.line/end.line`、语言 ID。
3. **上下文扩展**：用 `vscode.executeDocumentSymbolProvider` 拿到光标/选区所属的符号，向上扩到函数边界（避免只给半截 `if` 块）；再补「文件头 40 行（imports）+ 相邻 20 行」作为最小可理解单元。
4. **投递**：命令里 `await vscode.commands.executeCommand('codeAgent.chatView.focus')` 后 `postMessage({ type: 'attachSelection', payload })`；面板渲染成 chip，用户可删、可再选。
5. **大选区策略**：> 200 行时只附 `file_outline` + 选区首尾各 40 行，并在 chip 上标注「已折叠（共 800 行）」，模型需要时再用 `read_file` 精读。
6. **不打断输入**：若用户正在输入，把选区插入为 chip 而非覆盖草稿。

> 工程细节：`when` 条件里不要用 `resourceScheme == file` 之外的复杂表达式，否则在 diff 编辑器、notebook、虚拟文档里会误显示。对只读文档（diff 侧、预览侧）要提前 `return`。

---

## 10. 沙箱改动（Sandbox Staging）

### 10.1 三种「沙箱」，先分清

| 级别 | 机制 | 防什么 | 本项目 |
| --- | --- | --- | --- |
| **S0 无隔离** | 模型直接写文件 | 什么都不防；改坏了只能靠 git 兜底 | ❌ |
| **S1 改动隔离（内存 Overlay）** | 读真实工作区，写只写内存；产出 diff 提案，审批后一次性落地 | 误改、半截改动、顺序失控 | ✅ **v1 采用** |
| **S2 环境隔离（影子副本）** | `git worktree` / 临时目录 / copy-on-write 副本，在副本里跑构建与测试 | 构建产物污染、测试副作用 | 🔬 v2 |
| **S3 执行隔离（容器/微虚拟机/OS sandbox）** | Docker、gVisor、Firecracker、bubblewrap/landlock、macOS seatbelt | 不可信代码的任意副作用（网络、文件、进程） | 🧪 v3，仅 `run_command` |

**必须讲清楚的边界**：S1 只是「改动隔离」，**不是安全隔离**。它能保证「你没点接受，磁盘上就什么都没变」，但不能保证「模型输出的代码是安全的」——因为 v1 根本不执行模型代码。一旦引入 `run_command`/`run_test`，就必须上 S3，否则等于把任意代码执行权交给模型。工业界的分水岭也在这里：OpenHands 把执行放进 Docker runtime；OpenAI Codex CLI 在 macOS 用 seatbelt、Linux 用 landlock/seccomp 把命令关进笼子；Cline 则干脆把「执行终端命令」交给 VS Code 终端并逐条询问。

### 10.2 数据结构

```ts
// core/sandbox/types.ts
interface SandboxFS {
  read(uri: Uri): Promise<string>;                    // 未修改 -> 回落真实文件
  write(uri: Uri, text: string): Promise<void>;       // 只写 overlay
  delete(uri: Uri): Promise<void>;
  rename(from: Uri, to: Uri): Promise<void>;
  diff(): FileChange[];                               // 与基线的差异
  base(uri: Uri): string | undefined;                 // 基线内容（预览左侧用）
  discardAll(): void;
}

interface FileChange {
  path: string;
  kind: 'create' | 'update' | 'delete';
  baseHash: string;                  // 提案生成时的磁盘文件 sha1
  baseText: string;                  // 预览左侧
  newText: string;                   // 预览右侧
  hunks: Hunk[];
  units: FunctionUnit[];             // 审批分组
  stats: { additions: number; deletions: number };
}

interface Hunk {
  id: string;                        // 稳定 id：`${path}#${index}`
  oldStart: number; oldLines: number;
  newStart: number; newLines: number;
  header: string;                    // "@@ -12,7 +12,9 @@ fn parseConfig()"
  lines: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }>;
}

interface FunctionUnit {
  id: string;                        // `${path}::${symbolPath}`
  symbolPath: string;                // "ConfigParser.parse" / "<top-level>"
  kind: 'function' | 'method' | 'class' | 'module';
  range: { startLine: number; endLine: number };
  hunkIds: string[];
  risk: 'low' | 'medium' | 'high';
}

interface ChangeSet {
  id: string; taskId: string; mode: 'builder' | 'debugger';
  createdAt: number;
  files: FileChange[];
  status: 'proposed' | 'partially-applied' | 'applied' | 'rejected' | 'stale';
}
```

### 10.3 流水线（7 步）

```
① 模型调 propose_patch(path, unifiedDiff)
② 校验 patch（语法/上下文行数/文件是否存在/是否在禁止清单）
③ 应用到 SandboxFS（不落盘），得到 newText
④ 从 patch 原文反解出 Hunk 列表（不靠「再 diff 一次」，避免丢信息）
⑤ 函数归属：DocumentSymbol 计算「包含 hunk 的最近符号」→ FunctionUnit 分组
⑥ 冲突检测：baseHash vs 当前磁盘 hash；不一致标 stale
⑦ 生成 ReviewPlan → 渲染预览 → 用户选择 → WorkspaceEdit 落地
```

为什么第 ④ 步要「反解 patch」而不是「比较前后文本再 diff」：模型给的 patch 里带着它**意图的边界**（哪几行属于一个改动），重新 diff 会把相邻改动合并成一个大 hunk，破坏「逐函数审批」的粒度。

### 10.4 应用策略

```ts
// 选中 hunk → 生成 TextEdit（按行区间，而非整文件替换）
const edits = selectedHunks
  .sort((a, b) => b.newStart - a.newStart)          // 从后往前，避免行号漂移
  .map(h => new vscode.TextEdit(
      new vscode.Range(h.newStart - 1, 0, h.newStart - 1 + h.oldLines, 0),
      h.lines.filter(l => l.kind !== 'del').map(l => l.text).join('\n') + '\n'));

const wsEdit = new vscode.WorkspaceEdit();
edits.forEach(e => wsEdit.replace(uri, e.range, e.newText));
await vscode.workspace.applyEdit(wsEdit);            // 一个 undo 步，只触及改动行
```

三条硬规则：

1. **只改行区间，不整文件覆盖**：整文件 `replace` 会吃掉用户在同一文件里的其它未保存编辑，也会让 undo 粒度变成一个巨大的「整文件替换」。
2. **一次 `applyEdit` = 一个撤销单元**：用户 `Ctrl+Z` 能整体回退这次审批，符合直觉。
3. **apply 前重算偏移**：文本可能被用户改过，按上下文行重新定位后再生效；定位失败就标 conflict 并跳过该 hunk。

### 10.5 一致性与回滚

- **半截重构**是「逐条接受」的固有风险（改了签名却只接受一半调用点）。缓解见 [§11.4](#114-部分接受的一致性)。
- 应用后立刻跑一遍 `get_diagnostics`，把**新增**的错误按文件列出来（对比应用前后诊断快照）。
- 备份：默认不额外备份（`WorkspaceEdit` 的 undo + git 双保险已足够）；对「删除文件」这类不可撤销操作，先把原内容存 `.codeagent/backup/<timestamp>/`。
- 「撤销本次改动」= 反向 patch，同样走审批 UI，不搞隐式魔法。

### 10.6 v1 的边界与后续演进

| 能力 | v1 | v2 | v3 |
| --- | --- | --- | --- |
| 改文件 | Overlay + 审批 | 同左 | 同左 |
| 跑命令/测试 | ❌（默认关） | 🔬 影子 worktree 内执行 | 🧪 容器/OS sandbox 内执行 |
| 网络访问 | 模型请求本身 | 同左 | 容器内默认禁网 |
| 多文件大规模重构 | 支持但限额（≤ 20 文件/次） | 分批提案 | 分批 + 后台任务 |

---

## 11. 变更预览与逐函数审批

### 11.1 预览怎么画「红删绿增」

VS Code 的 diff 编辑器**原生**就是这个语义：左侧（Original）被删的行标红、右侧（Modified）新增的行标绿，行内还有字符级高亮。所以我们要做的不是「自己画颜色」，而是**给 diff 编辑器喂两份内容**：

```ts
// 1) 注册两种只读虚拟文档 scheme
vscode.workspace.registerTextDocumentContentProvider('codeagent-base', provider);
vscode.workspace.registerTextDocumentContentProvider('codeagent-proposed', provider);

// 2) 单文件预览
await vscode.commands.executeCommand('vscode.diff',
  baseUri,        // codeagent-base:/abs/path?cs=<id>
  proposedUri,    // codeagent-proposed:/abs/path?cs=<id>
  `${basename} — 改动预览（已删除 / 新增）`,
  { preview: true, preserveFocus: true });

// 3) 多文件总览：内置「多文件 diff 编辑器」
await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
  title: 'Code Agent 改动（3 个文件）',
  resources: files.map(f => ({ originalUri: base(f), modifiedUri: proposed(f) }))
});
```

- 虚拟文档必须 `readonly`（`TextDocumentContentProvider` 天然只读），防止用户在预览里手改造成假象。
- 单文件超过 5k 行时，预览默认**折叠未改动区域**（`vscode.diff` 的 `hideUnchangedRegions` 选项），只展开 hunk 周边。
- 目录级新增/删除文件：新建文件用「空内容 → 新内容」的 diff，删除文件用「原内容 → 空内容」的 diff，语义一致。

### 11.2 从 hunk 到「函数单元」

```ts
async function groupByFunction(file: FileChange, symbols: DocumentSymbol[]): FunctionUnit[] {
  const units = new Map<string, FunctionUnit>();
  for (const h of file.hunks) {
    const startLine = h.newStart;
    const endLine = h.newStart + h.newLines;
    // 取「包含该 hunk 的最小符号」——即最近的函数/方法
    const owner = smallestEnclosingSymbol(symbols, startLine, endLine);
    const key = owner ? `${file.path}::${symbolPathOf(owner)}` : `${file.path}::<top-level>`;
    // 跨符号的大 hunk：退化为共同父符号，再退化到 <top-level>
    ...
  }
  return [...units.values()].sort((a, b) => a.range.startLine - b.range.startLine);
}
```

符号来源优先级：

1. **LSP DocumentSymbol**：`vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` —— 无需自己解析，TS/Python/Go/Java/Rust 的官方扩展都提供，最准。
2. **tree-sitter 兜底**：`web-tree-sitter` + 各语言 wasm，用于没有 LSP 的语言（也是 Aider 生成 repo map 的做法）。
3. **正则/缩进启发式**：最后的兜底，只在拿不到符号时用，且 UI 上标注「按缩进推断」。

### 11.3 审批 UI

```
┌ Code Agent · 改动待审（3 个文件 / 7 个函数 / 11 个 hunk）──────────────┐
│ ☑ src/config/parse.ts                                             │
│   ☑ parseConfig()            4 hunk   +18 −6   [查看 diff] 低风险    │
│   ☑ ConfigParser.resolve()   1 hunk   +3  −1   [查看 diff] 中风险    │
│ ☐ src/config/parse.test.ts                                        │
│   ☐ 新增 3 个用例             2 hunk   +42 −0   [查看 diff] 低风险    │
│ ☑ src/index.ts                                                    │
│   ☑ main()（调用点变更）       4 hunk   +6  −6   [查看 diff] 高风险 ⚠ │
├───────────────────────────────────────────────────────────────────┤
│ [逐条接受]  [全部接受 ⌘⏎]  [全部拒绝]  [导出 patch]                  │
└───────────────────────────────────────────────────────────────────┘
```

- **三档粒度**（`codeAgent.review.granularity`）：`function`（默认，按函数整体接受）→ `hunk`（更细）→ `file`（更粗）。
- **风险分级**：删除行 > 30、触碰 `package.json`/CI/`*.config.*`、新增依赖、删除文件、修改测试 → `medium/high`，高风险项在「全部接受」时二次确认。
- **联动勾选**：同一函数内的 hunk 默认整组；跨文件的「同一次签名变更」用一个「关联组」横幅提示，取消部分勾选时警告「调用点未全部更新」。
- **键盘**：`A` 接受当前、`R` 拒绝当前、`Shift+A`/`Shift+R` 全部、`↑↓` 移动、`Enter` 打开 diff、`Space` 勾选 —— 全程不离开键盘。
- **一键接受**要「快但可刹车」：无高风险 → 立即应用并 toast「已应用 7 个改动 · 撤销」；有高风险 → 弹出高风险清单确认。

### 11.4 部分接受的一致性

逐条接受最大的坑不是技术，而是**语义**：接受了一半的改动，代码可能编译不过。三道防线：

1. **关联组提示**（上文）。
2. **应用后诊断对比**：新增错误以「本次改动引入 2 个类型错误」的形式挂到面板，并提供「查看 →」跳到错误行。
3. **可选「接受并验证」**：v2 起，接受后在影子环境跑一次 `typecheck`/`test`，把结果贴在 ChangeSet 卡片上（不阻塞应用，只提示）。

### 11.5 与 git 的关系

- Agent **不自动 commit**，把提交权 100% 留给用户。
- 可选设置：接受后自动 `git add`（只 stage，不 commit），方便用户 `git diff --cached` 复查。
- 预览的「导出 patch」按钮：把 ChangeSet 序列化成标准 `git apply` 可用的 patch，便于用户拿去 code review 或在别处应用。

---

## 12. 安全与隐私

### 12.1 密钥

- 只存 `SecretStorage`，见 [§5.3](#53-密钥存储)。
- 所有日志走 `redact()`：`/sk-[A-Za-z0-9_\-]{8,}/g`、`/Bearer\s+\S+/gi`、`/([?&](api_?key|token)=)[^&]+/gi`。
- 「导出诊断包」功能默认剔除：prompt 全文、文件内容、密钥、内网 URL。
- 明确声明：**扩展没有后端**，请求直达用户配置的 `base_url`；不接入任何遥测（或首次启动显式询问，默认关）。

### 12.2 工作区信任（Workspace Trust）

- 声明 `capabilities.untrustedWorkspaces.supported: "limited"`：受限模式下禁用 `run_command`/`run_test`，仅允许只读 + 沙箱提案。
- 打开不受信任工作区时，在面板顶部显示警示条。

### 12.3 文件访问边界

- 所有路径 `path.resolve` 后必须 `startsWith(workspaceRoot)`，拒绝 `..` 穿越与符号链接逃逸。
- 默认拒绝写入：`.git/**`、`node_modules/**`、`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.codeagent/secrets*`。
- 读取大文件截断（> 512KB 拒绝，> 100KB 只给大纲 + 片段）。
- 忽略规则三层合并：内置默认 → `.gitignore` → 用户 `codeAgent.files.exclude`。

### 12.4 命令执行

- v1 默认 **不启用**。
- 启用后：命令 allowlist（`npm test`、`pytest`、`go build`…）+ 每次执行前弹确认（显示完整命令行、cwd、超时）+ 输出截断回填。
- 🧪 沙箱化执行方案见 [§10.6](#106-v1-的沙箱边界与后续演进)——宿主机隔离（容器/沙箱）是「真隔离」与「假隔离」的分水岭。

---

## 13. Skill 与 MCP 集成

### 13.1 Skill（可复用的领域知识包）

```
.codeagent/skills/<skill-name>/
├─ SKILL.md          # 必填：front-matter + 正文
├─ examples/         # 可选：few-shot 片段
└─ scripts/          # 可选：可被工具调用的小脚本
```

```markdown
---
name: react-form-refactor
description: 把受控表单重构为 react-hook-form + zod 校验
when_to_use: 用户要求迁移表单校验逻辑、或改造 Form 组件时
allowed_tools: [read_file, search_code, file_outline, propose_patch]
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
// .codeagent/mcp.json（与 VS Code 的 .vscode/mcp.json 结构对齐，便于互操作）
{
  "servers": {
    "github": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": { "GITHUB_TOKEN": "${secret:codeAgent.mcp.github}" } },
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

## 15. 目录结构

```
code-agent/
├─ package.json                  # VS Code 扩展清单（manifest）
├─ tsconfig.json                 # 基础 TS 配置
├─ tsconfig.core.json            # core 子项目（无 DOM/vscode 类型）
├─ esbuild.mjs                   # 扩展打包（node 平台，cjs）
├─ .vscodeignore                 # vsce 打包排除
├─ .gitignore
├─ CHANGELOG.md
├─ README.md                     # 本文件
├─ LICENSE                       # Apache-2.0（待定）
├─ docs/
│  ├─ architecture.md            # 详细架构（本文档的精编版）
│  ├─ prompts.md                 # 三模式提示词变更记录
│  ├─ sandbox-and-review.md      # 沙箱与审批协议
│  └─ adr/                       # 架构决策记录
│     ├─ 0001-core-free-of-vscode.md
│     ├─ 0002-bring-your-own-endpoint.md
│     └─ 0003-change-as-proposal.md
├─ src/                          # 扩展侧（可 import vscode）
│  ├─ extension.ts               # activate / deactivate
│  ├─ commands/                  # 命令注册与路由
│  ├─ ports/                     # VS Code 能力 → 端口接口
│  │  ├─ workspacePort.ts        #   files / findFiles / fs
│  │  ├─ symbolsPort.ts          #   DocumentSymbol
│  │  ├─ secretPort.ts           #   SecretStorage
│  │  ├─ diffPort.ts             #   vscode.diff / 多文件 diff / 装饰
│  │  └─ editPort.ts             #   WorkspaceEdit 原子应用
│  ├─ views/                     # WebviewViewProvider / TreeDataProvider
│  └─ webview/                   # 面板 HTML 装配、CSP、消息桥
├─ src/core/                     # 内核（❗禁止 import vscode）
│  ├─ loop/                      # AgentLoop、状态机、事件
│  ├─ modes/                     # 模式定义与能力矩阵
│  ├─ prompts/                   # 模板装配（base + overlay）
│  ├─ llm/                       # OpenAI 兼容客户端、SSE、重试、用量
│  ├─ context/                   # 索引、检索、预算、压缩
│  ├─ tools/                     # 注册表、schema、内置工具
│  ├─ sandbox/                   # SandboxFS、overlay、冲突基线
│  ├─ changeset/                 # patch 解析、函数归并、审批计划
│  ├─ guard/                     # 预算与死循环守卫
│  ├─ mcp/                       # MCP 客户端
│  └─ skills/                    # 技能发现与按需加载
├─ webview/                      # 前端（Vite + React + Monaco Diff 可选）
│  ├─ src/
│  └─ vite.config.ts
├─ test/
│  ├─ unit/                      # vitest（core，纯 Node）
│  └─ integration/               # @vscode/test-electron（跑真扩展宿主）
└─ .github/workflows/
   ├─ ci.yml                     # lint + typecheck + test + package
   └─ release.yml                # tag → vsix → GitHub Release
```

---

## 16. 路线图

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M0 骨架** | 扩展脚手架、命令、面板、SecretStorage、模型配置向导、单轮对话 | 填入 DeepSeek/Ollama 端点后能一问一答，流式输出正常 |
| **M1 只读 Agent** | Agent Loop、只读工具、文件清单、检索、Chat 模式、选区快捷键 | Chat 模式能自主读 3~5 个文件后准确回答带行号的解释 |
| **M2 沙箱与审批** | SandboxFS、`propose_patch`、ChangeSet、Multi-Diff 预览、逐函数审批 | Builder 改 3 个文件，能逐函数接受/拒绝，接受后 typecheck 通过 |
| **M3 Debugger** | 诊断接入、Debugger 提示词、验证回路（可选 run_test） | 给一个真 bug，能定位到正确函数并给出最小补丁 |
| **M4 扩展生态** | Skill 加载、MCP 客户端、压缩与记忆、成本面板 | 挂 3 个 MCP server + 10 个 skill，会话稳定不爆 token |
| **M5 发布** | vsce 打包、CI、Marketplace 上架、GitHub Release | `code --install-extension code-agent-x.y.z.vsix` 可用 |

---

## 17. 开发与构建

```bash
# 依赖
npm install          # 本仓库用 npm（若本机有 pnpm 也可 pnpm i）

# 开发扩展
npm run watch        # esbuild --watch
# 在 VS Code 里按 F5（Run Extension）启动「扩展开发宿主」

# 前端面板
npm run dev:webview

# 质量
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest run（core 单测）
npm run test:it      # @vscode/test-electron 集成测试

# 打包/发布
npx @vscode/vsce package            # 生成 .vsix
npx @vscode/vsce publish -p <PAT>   # 发布到 Marketplace
```

`package.json` 关键字段（草案）：

```jsonc
{
  "name": "code-agent",
  "displayName": "Code Agent",
  "publisher": "<publisher>",
  "version": "0.0.1",
  "engines": { "vscode": "^1.104.0" },
  "categories": ["Programming Languages", "Machine Learning", "Other"],
  "main": "./dist/extension.js",
  "activationEvents": [],                        // 1.74+ 由 contributes 隐式激活
  "contributes": {
    "commands": [
      { "command": "codeAgent.chat.ask",       "title": "Code Agent: 提问（Chat）" },
      { "command": "codeAgent.selection.chat", "title": "Code Agent: 解释选中代码" },
      { "command": "codeAgent.selection.build","title": "Code Agent: 按选中代码生成改动" },
      { "command": "codeAgent.selection.debug","title": "Code Agent: 排查选中代码" },
      { "command": "codeAgent.files.pick",     "title": "Code Agent: 选择要阅读的文件" },
      { "command": "codeAgent.model.configure","title": "Code Agent: 配置模型（base_url / key / model）" },
      { "command": "codeAgent.review.acceptAll","title": "Code Agent: 接受全部改动" }
    ],
    "keybindings": [
      { "command": "codeAgent.selection.chat",  "key": "ctrl+alt+k", "mac": "cmd+alt+k", "when": "editorHasSelection" },
      { "command": "codeAgent.selection.build", "key": "ctrl+alt+b", "mac": "cmd+alt+b", "when": "editorHasSelection" },
      { "command": "codeAgent.selection.debug", "key": "ctrl+alt+d", "mac": "cmd+alt+d", "when": "editorHasSelection" }
    ],
    "menus": {
      "editor/context": [
        { "command": "codeAgent.selection.chat",  "when": "editorHasSelection", "group": "codeAgent@1" },
        { "command": "codeAgent.selection.build", "when": "editorHasSelection", "group": "codeAgent@2" },
        { "command": "codeAgent.selection.debug", "when": "editorHasSelection", "group": "codeAgent@3" }
      ]
    },
    "viewsContainers": {
      "activitybar": [{ "id": "codeAgent", "title": "Code Agent", "icon": "media/icon.svg" }]
    },
    "views": {
      "codeAgent": [{ "id": "codeAgent.chatView", "name": "Agent", "type": "webview" }]
    },
    "configuration": { "title": "Code Agent", "properties": { /* §5.2 */ } }
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
git remote add origin git@github.com:<you>/code-agent.git
git push -u origin main
```

### 18.2 分支与提交

- 分支：`main`（可发布）← `feat/*`、`fix/*`、`docs/*`、`refactor/*`；发布用 `release/x.y.z` 打 tag。
- 提交信息遵循 **Conventional Commits**：`feat(loop): 支持并行 tool_calls`、`fix(sandbox): 修正 hunk 偏移`、`docs(readme): 补充审批流程`。
- 一次提交只做一件事；提示词改动单独提交（`docs(prompts): 收紧 builder 输出契约`），便于回溯「哪次改提示词导致了效果退化」。

### 18.3 版本与发布

- SemVer：`0.x` 阶段允许破坏性变更，但必须在 `CHANGELOG.md` 标注 **BREAKING**。
- 发布链路：`git tag v0.1.0` → CI 构建 `.vsix` → GitHub Release 附 `.vsix` → `vsce publish`。
- Marketplace 发布需要一个 Azure DevOps PAT（`Marketplace > Manage` 权限）与在 `publisher` 下注册的扩展名；`README.md` 会作为详情页正文渲染，因此**本文件同时就是商店页**。

### 18.4 开源协作常规件

`LICENSE`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`（披露渠道与「密钥泄露如何处理」）、`.github/ISSUE_TEMPLATE/*`、`Dependabot`。

---

## 19. 许可与致谢

- 许可证：**Apache-2.0**（待定；含专利授权，适合被集成）。
- 致谢（设计上借鉴的开源项目）：Cline、Continue.dev、Aider、OpenHands、以及 VS Code 官方扩展样例。具体借鉴点见 [§14](#14-工业界参考)。
