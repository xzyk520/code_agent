[English](README.en.md) | 中文

<p align="center"><img src="media/icon-128.png" width="88" height="88" alt="Bee Code 图标"></p>

# Bee Code

> **自带模型的代码智能体 VS Code 扩展。** Chat / Builder / Debugger 三模式，统一 OpenAI 兼容协议，改动先以**虚拟文件提案**逐文件预览，接受才落盘，随时整轮 Restore。

**状态**：`v0.0.1` · 壳可用、内核开发中 · MIT

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

内核目前是**协议骨架**（`initialize` / `shutdown` / `model.reload` 可用，`chat.send` 待实现）。开发环境：

```bash
conda activate beeagent          # Python 3.11；也可用任意 venv
pip install -e ".[dev]"          # httpx / pydantic / pytest
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
| 扩展壳（命令/面板/密钥/写入/检查点/RPC） | ✅ 可构建、可调试、`tsc` 零错 |
| 协议骨架（`beecode/ipc.py` + `shell.py`） | ✅ 双向 RPC 已通 |
| Agent 循环、提示词、检索、工具、补丁 | ⬜ 待实现（`beecode/__main__.py` 里的 TODO） |
| 打包分发（sidecar / bootstrap） | ⬜ 见 [docs/development.md](https://github.com/xzyk520/code_agent/blob/main/docs/development.md) |

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](https://github.com/xzyk520/code_agent/blob/main/docs/architecture.md) | 分层设计、三模式提示词、模型接入与兼容矩阵、IPC 契约、上下文工程、写入+待审流程、工业界对照 |
| [docs/development.md](https://github.com/xzyk520/code_agent/blob/main/docs/development.md) | 目录结构、路线图、构建与打包、Python 分发方案、Git 工作流 |
| [docs/reference.md](https://github.com/xzyk520/code_agent/blob/main/docs/reference.md) | VS Code / MCP / LSP 官方文档与工业实践出处 |

## 打包

```bash
npm run package        # → bee-code-0.0.1.vsix（14 个文件，约 80 KB）
```

`.vscodeignore` 已排除 `src/`、`docs/`、`tests/`、`node_modules/`、`__pycache__`；`vscode:prepublish` 走 `--production`（压缩 + 去 sourcemap），开发版与发布版体积差 7 倍。

## 许可证

[MIT](LICENSE)。欢迎 Issue / PR。
