[English](README.en.md) | 中文

<p align="center"><img src="media/icon-128.png" width="88" height="88" alt="Bee Code 图标"></p>

# Bee Code

> **自带模型的代码智能体 VS Code 扩展。** Chat / Builder / Debugger 三模式，统一 OpenAI 兼容协议，改动先以**虚拟文件提案**逐文件预览，接受才落盘，随时整轮 Restore。

**状态**：`v1.0.0` · 正式发布 · Windows / macOS / Linux · MIT

---

## 它解决什么

| 痛点 | Bee Code 的做法 |
| --- | --- |
| 只能用厂商绑定的模型/订阅 | 自己填 `model` / `api_key` / `base_url`，任意 OpenAI 兼容端点：OpenAI、DeepSeek、Qwen、Kimi、GLM、OpenRouter、Ollama、vLLM、one-api 网关… |
| 一套提示词打天下，解释/生成/修 bug 都不极致 | 三个模式各有独立提示词、独立工具集、独立的「允许做什么」约束 |
| AI 改完文件才发现改坏了 | 改动先做成**提案**：源文件在接受前一字不改，逐文件 `Accept`/`Reject`；影子 git 检查点兜底，可整轮 `Restore` |
| AI 看不到「跟这个问题相关」的代码 | 文件清单索引 + 关键词/符号检索 + 工具驱动的按需精读 |
| 想改一段代码要先复制粘贴到聊天框 | 选中即问：`Ctrl+Alt+K/B/D` 直接进 Chat / Builder / Debugger |

**没有后端、没有中转、没有遥测**：API Key 只存 VS Code `SecretStorage`（OS 凭据库），请求直达你自己填的 `base_url`。

## 语言

用设置 `beeCode.ui.language` 切换面板、提示、通知和日志的语言：默认 `en`，可选 `zh`。给模型看的提示词和工具描述始终是英文；模型回复跟随用户提问的语言。

## 架构一览

```
┌─ Webview 面板（media/panel.js，纯浏览器 JS）
├─ TS 薄壳（src/）        命令 · 面板宿主 · SecretStorage · WorkspaceEdit · QuickDiff · 影子 git
│        ⇅  JSON-RPC 2.0 over stdio（NDJSON 分帧）
├─ Python 内核（beecode/） AgentLoop · 提示词 · 上下文 · 工具 · 补丁 · 守卫
└─ 模型端点（用户自带 base_url）
```

壳只做「VS Code 世界的事」，内核不 `import vscode`——所以 agent 逻辑能脱离编辑器单测，也能接到 CLI。完整设计见 [docs/architecture.md](https://github.com/xzyk520/code_agent/blob/main/docs/architecture.md)。

## Skills 与 MCP

侧边栏的 **Skills & MCP** 视图支持拖入或选择：

- Skill 文件夹（包含 `SKILL.md`）：安装到 `.beecode/skills/`
- `mcp.json`：安装到 `.beecode/mcp.json`

Skill 会在系统提示词中显示索引，模型按需调用 `read_skill` 读取全文。MCP 服务器在每轮对话时启动，工具自动注册为 `mcp__<server>__<tool>`。

`mcp.json` 示例：

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

## 内置 Python

发布版可以内置 Windows Python 运行时，用户无需安装 Python：

```powershell
npm run bundle:python
```

Windows 使用官方 embeddable；macOS/Linux 使用 python-build-standalone：

```text
runtime/win32-x64/python.exe
runtime/darwin-arm64/bin/python3
runtime/linux-x64/bin/python3
```

按平台打包：

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

输出：

```text
dist-vsix/bee-code-1.0.0-win32-x64.vsix
dist-vsix/bee-code-1.0.0-darwin-arm64.vsix
dist-vsix/bee-code-1.0.0-linux-x64.vsix
```

每个 VSIX 只包含对应平台的 runtime。GitHub Actions 的 `release-vsix.yml` 会自动在三个平台分别构建。`runtime/` 和 `dist-vsix/` 不提交 Git，但会被打进 VSIX。

扩展到 `beeCode.core.pythonPath = "auto"` 时会优先使用内置运行时；找不到才回退到系统 `python`。构建机需要网络；普通用户安装 VSIX 后不需要 Python 或 pip。

## 快速开始

```bash
npm install            # 壳依赖
npm run build          # esbuild → dist/extension.js（开发版带 inline sourcemap）
npm run typecheck      # tsc --noEmit + 面板侧 checkJs，必须单独跑（esbuild 不查类型）
```

1. 用 VS Code 打开本仓库，按 **F5** → 新开一个「扩展开发宿主」窗口；
2. 在新窗口里运行命令 **`Bee Code: 配置模型`**，依次填入 `base_url` / `model` / `api_key`（密钥写入 `SecretStorage`，不进 `settings.json`）；
   摘要模型可单独配置：运行 **`Bee Code: 配置摘要模型`**（留空 = 沿用主模型）；
3. 侧边栏点 Bee Code 图标打开面板。

### 只想调壳、不想碰内核？

设置 `beeCode.core.mode` 为 `mock`，扩展会用内置假内核跑通流式输出、待审列表与停止按钮。

### 接真实内核

内核已经实现完整对话、工具循环、提案、检查点、Skills 与 MCP。开发环境：

```bash
conda activate beeagent          # Python 3.11；也可用任意 venv
pip install -e ".[dev]"          # httpx / pydantic
```

壳会按下面的顺序自动找内核（`PYTHONPATH` 自动注入，`cwd` 默认工作区根）：

```
beeCode.core.coreRoot 显式设置  →  工作区根/beecode  →  扩展目录/beecode
```

手动冒烟测试（不需要 VS Code）：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"workspaceRoots":[],"modelConfig":{}}}' \
  | python -m beecode
```

## 技术栈

| 部分 | 选择 | 说明 |
| --- | --- | --- |
| 壳 | TypeScript **6.0.3**（精确） | 与 VS Code 内置 TS 一致；不写 `^`，否则又会「本地绿、编辑器红」 |
| 类型 | `@types/vscode` **1.90.0**（精确） | 与 `engines.vscode` 地板一致，编译期就挡住高版本 API |
| 打包 | esbuild → 单文件 CJS | `vscode` 保持 external；包体 44 KB |
| 内核 | Python 3.11 + httpx + pydantic | 不依赖 VS Code，可单独跑 |
| 协议 | JSON-RPC 2.0 / NDJSON | 与 LSP、MCP 同构，可手工喂 stdin 调试 |

## 项目状态

| 部分 | 状态 |
| --- | --- |
| 扩展壳（命令/面板/密钥/写入/检查点/RPC） | ✅ 正式可用 |
| Python 内核（Agent 循环、提示词、工具、压缩、守卫） | ✅ 正式可用 |
| 提案审批 / diff 预览 / 自动保存 / checkpoint Restore | ✅ 正式可用 |
| Skills / MCP 导入与运行 | ✅ 正式可用 |
| Windows / macOS / Linux 分平台 VSIX | ✅ 已接入发布流程 |
| Marketplace 发布 | ⚠️ 需要 Publisher + PAT（见文档） |

## 支持平台

| 平台 | 安装包 | 内置 Python |
| --- | --- | --- |
| Windows x64 | `bee-code-1.0.0-win32-x64.vsix` | ✅ 官方 embeddable |
| macOS ARM64 | `bee-code-1.0.0-darwin-arm64.vsix` | ✅ python-build-standalone |
| Linux x64 | `bee-code-1.0.0-linux-x64.vsix` | ✅ python-build-standalone |
| macOS Intel | 使用系统 Python 或 `Set up Python core` | ⚠️ 暂未单独内置 |

安装后默认 `beeCode.core.pythonPath = "auto"`，优先使用包内 runtime。用户不需要单独安装 Python、pip 或 httpx。

## GitHub 项目说明

建议仓库 About 使用：

```text
Description: BYO-model coding agent for VS Code. Three modes, per-file proposal approval, bundled Python, Skills and MCP.
Topics: vscode-extension, coding-agent, ai, agents, mcp, skills, deepseek, openai-compatible, typescript, python
```

仓库主页应优先展示本 README；Marketplace 详情页也直接使用 `README.md`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](https://github.com/xzyk520/code_agent/blob/main/docs/architecture.md) | 分层设计、三模式提示词、模型接入与兼容矩阵、IPC 契约、上下文工程、写入+待审流程、工业界对照 |
| [docs/development.md](https://github.com/xzyk520/code_agent/blob/main/docs/development.md) | 目录结构、路线图、构建与打包、Python 分发方案、Git 工作流 |
| [docs/reference.md](https://github.com/xzyk520/code_agent/blob/main/docs/reference.md) | VS Code / MCP / LSP 官方文档与工业实践出处 |

## 打包

### 按平台构建（推荐）

```bash
npm run bundle:python     # 首次构建会下载对应平台的 Python
npm run package:win       # → dist-vsix/bee-code-1.0.0-win32-x64.vsix
npm run package:mac       # → dist-vsix/bee-code-1.0.0-darwin-arm64.vsix
npm run package:linux     # → dist-vsix/bee-code-1.0.0-linux-x64.vsix
```

Windows 包约 19 MB（含内置 Python）；macOS/Linux 包由对应平台构建，约 20–25 MB。

通用包（若本地存在 `runtime/` 会一并打包）：

```bash
npm run package
```

`.vscodeignore` 已排除 `src/`、`docs/`、`node_modules/`、`scripts/`、`tools/`、`__pycache__`；`runtime/` 会包含在平台包中。`vscode:prepublish` 走 `--production`（压缩 + 去 sourcemap）。

## 许可证

[MIT](LICENSE)。欢迎 Issue / PR。

