# Bee Code 开发与发布

> 目录结构、路线图、构建流程、Git 工作流与许可证说明。
> 依赖版本策略见 README「技术栈」一节。
## 15. 目录结构

✅ = 已实现（v0.0.1 壳骨架）　⬜ = 待实现

```
bee-code/
├─ package.json                  # ✅ 扩展清单：12 个命令 / 3 个快捷键 / 菜单 / 视图 / 16 项配置
├─ tsconfig.json                 # ✅ 扩展侧：lib 无 DOM、strict、verbatimModuleSyntax、module=preserve
├─ tsconfig.webview.json         # ✅ 前端侧：lib 含 DOM、allowJs+checkJs、不含 node/vscode 类型
├─ esbuild.mjs                   # ✅ 打包 → dist/extension.js（cjs，vscode 保持 external）
├─ .vscodeignore                 # ✅ vsce 打包排除规则
├─ .vscode/                      # ✅ launch.json（Extension + debugpy attach）、tasks.json
├─ .gitignore / .gitattributes   # ✅（本地 .vscode/settings.json 已忽略）
├─ README.md / LICENSE (MIT)     # ✅
├─ pyproject.toml                # ✅ 内核工程定义（hatchling，httpx + pydantic）
├─ docs/                         # ✅ architecture / reference；⬜ ipc / prompts / change-review / adr
├─ src/                          # ★ TS 薄壳：唯一允许 import 'vscode' 的地方
│  ├─ extension.ts               # ✅ 装配根：内核生命周期、通知路由、命令依赖
│  ├─ coreApi.ts                 # ✅ 内核抽象（PythonCore / MockCore 共用接口）
│  ├─ protocol.ts                # ✅ 协议类型 + 方法名 + NDJSON 分帧（LineReader）
│  ├─ contract.ts                # ✅ 读 contract.json，与运行时注册表对账（启动自检）
│  ├─ config.ts                  # ✅ 设置读取（带类型/范围校验）、${workspaceFolder} 解析、会话 id
│  ├─ coreLocator.ts             # ✅ 内核定位：工作区 → 扩展目录，注入 PYTHONPATH / 编码变量
│  ├─ diagnostics.ts             # ✅ 导出脱敏诊断包（落 globalStorage，可另存）
│  ├─ paths.ts                   # ✅ 路径策略（越界 / 敏感文件 / 禁止目录）
│  ├─ log.ts                     # ✅ 双 LogOutputChannel（自动落盘）+ 脱敏 + 500 行缓冲
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
│  ├─ contract.py                # ✅ 读 protocol/contract.json，发 RPC 前校验方法名与参数
│  ├─ shell.py                   # ✅ ShellClient：fs/search/edit/checkpoint/diff/confirm 的类型化封装
│  ├─ loop/ modes/ prompts/      # ⬜ AgentLoop、模式、提示词
│  ├─ llm/ context/ tools/       # ⬜ OpenAI 客户端、检索编排、工具
│  ├─ apply/ pending/ guard/     # ⬜ 补丁解析、待审状态机、预算守卫
│  └─ mcp/ skills/               # ⬜ MCP 客户端、Skill 加载
├─ protocol/contract.json        # ✅ 协议唯一真相（方法/参数/返回字段），两侧启动时对账
├─ tests/                        # ◐ python/test_contract.py ✅；shell/ (@vscode/test-electron) ⬜
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

**TypeScript 固定在 `6.0.3`**（= 当前 VS Code 内置版本），刻意不写 `^`：写 `^` 时下次 `npm install` 会装到 6.x 的更高小版本，于是又回到「本地绿、编辑器红」。同理 **`@types/vscode` 精确固定 `1.90.0`**，与 `engines.vscode` 的地板一致——类型比地板新，就会让你不小心用上高版本 API：本地编译通过、打进 vsix 也成功，但在旧编辑器上一运行就 `undefined is not a function`。查看你所用 VS Code 的版本：

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
- 致谢（设计上借鉴的开源项目）：Cline、Continue.dev、Aider、OpenHands、以及 VS Code 官方扩展样例。具体借鉴点见 [§14 工业界参考](./architecture.md#14-工业界参考)。

---
