# Changelog

本文件记录所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **会话仓库**：完整对话按 JSONL 全量落盘（`<globalStorage>/sessions/<id>.jsonl` + `index.json`），
  支持「新建会话」「历史会话…」；重载后自动续上同一个会话，并按「上一轮停在哪」分流：
  模型生成 → 作废并提示；工具调用 → 可「继续上次的操作」；待审提案 → 可「重新生成提案」
- **上下文裁剪**（`src/contextBuilder.ts`）：发给模型的不是整份历史，而是「机械摘要 + 最近 8 条 + token 预算」；
  重载恢复与正常轮次走同一条构建路径（协议 v5 增加 `chat.send.summary`）

### Added

- **内核 M1：能对话**。新增 `session.py`（会话内存态）、`llm/openai.py`（OpenAI 兼容 SSE 流式客户端）、
  `loop/agent.py`（单轮循环）、`prompts/`（三模式系统提示）；`chat.send` 真正调模型并流式推送 `ui.delta`，
  `session.abort` 用 `task.cancel()` 真正取消，`shutdown` 取消在飞回合；同会话并发返回 `SIG_CONFLICT`
- 开发环境补装 `httpx`（内核首次真正联网）

### Changed

- **改动落地改为「提案 + 逐文件审批」（协议 v4）**：内核产出修正后的完整文件内容，作为**虚拟文件**预览
  （左=磁盘现状，右=提案），用户逐文件 `接受`/`拒绝`，或一键全部；**接受前源文件一字不改**。
  协议：`review.*` 与 `pending.changed` 被 `proposal.read` / `proposal.decide` / `proposal.changed` 取代；
  新增 `src/adapters/proposalAdapter.ts`，`diffAdapter` 增加 `openProposal`（反向 diff）。

- **命名与注释清理**：`protocol.ts` 文件头同步（`proposal.changed`、补上 `symbols.search/references`）；
  面板 HTML/CSS/JS 的 `pending` 旧命名改为 `proposals`（HTML id、CSS 类、JS 元素引用全部一致）
- **RPC 层修复**：`abort()` 现在会 reject 在飞的 `chat.send`（不再挂 30 分钟、不会出现并发 loop）；
  `stdin` 写入处理背压（`drain`）；错误码映射收敛到 `protocol.rpcCodeFor`（删掉 client/server 两份拷贝）；
  `initialize` 超时 20s → 60s 并区分「启动慢」与「版本不匹配」；重复注册 RPC 方法改为抛错；
  传输层拆成 `src/rpc/transport.ts`（分帧 / 背压 / 退出清理与 RPC 语义分离）
- **面板修复**：修复「回合结束后助手回复消失」（助手消息现在会写进面板 state，`pushState` 重渲染不再丢内容）；
  `status`（轻量）与 `state`（全量快照）拆分，`setHint/setBusy/setMode` 不再重发整段历史；消息上限 300 条（超出重发一次快照）；
  超长输入截断时给出提示；view 作用域监听器纳入统一释放；HTML id 修正；
  无障碍：消息区 `aria-live` + 流式期间 `aria-busy`、独立 `sr-only` 状态行播报「开始/完成 N 字/待审 N 个」
- **mock 内核修复**：取消改为即时（可取消的 sleep，不再等一个分片周期）；流式分片按 code point 切（emoji 不再被劈成孤立代理）；
  通知分发容错（一个 handler 抛错不影响其他）；补 `ui.tool` 事件（用于验证"重载时停在工具调用"）；
  提案指向工作区里真实存在的文件；新增 `beeCode.dev.crashMock` 命令验证内核崩溃路径
- **命令层修复（协议 v11）**：附件路径改为工作区相对（不再泄露绝对路径）；`untitled:` 文档标记 `untitled: true`
  （内核不会拿假路径去 `fs.read`）；多选区按范围去重；`CancelledError` 不再弹红框；命令成功也记 debug 耗时；
  新增启动自检 `undeclaredCommands()`——命令注册表与 `package.json` 声明对账
- **符号服务修复（协议 v10）**：`outline`/`search` 返回 `selection`（标识符精确行列），`references` 用它定位
  （之前用 `range.startLine` 会落在前导注释里，导致引用查询经常返回空）；LSP 搜索结果过滤工作区外与依赖目录；
  回退路径先按名字粗筛（不再用"函数定义"正则，避免漏掉 `foo() {}` 这类方法）、并跳过忽略路径；
  扁平符号用 `containerName`；`references` 去重 + 排序 + 过滤非 file 位置；新增 `shell.references_of_symbol()`
- **检索器加固（协议 v9）**：正则长度上限 300 / 嵌套量词启发式拒绝 / 单行匹配上限 2000 字符 / 整体 5 秒预算；
  新增 `caseSensitive` 与 `exclude`；`hits[].text` 统一为裸行（上下文移到 `context`、同行多次匹配记 `count`）；
  `filesOnly` 的计数不再被单行上限误伤，超过 1000 次的文件标 `capped`；结果按路径+行号排序保证可复现
- **提案正文缓存改为事件失效 + LRU**：去掉 30 秒 TTL；`upsert`（内核更新提案）时立即丢弃该 id 的缓存，
  容量上限 3 条 / 8 MB（LRU 淘汰），接受/拒绝后释放
- **提案面板修复**：`stale` 提案不再「凭空消失」（灰色显示、只能查看/丢弃）；同路径新提案自动把旧目标为失效；
  查看过的正文短期缓存（避免「查看 → 接受」拉两次）；`baseVersion` 缺失时记警告（不再静默无条件覆盖）；
  「全部接受」支持中途取消（命令 `beeCode.proposal.cancelAcceptAll`）
- **确认框修复（协议 v8）**：`detail` 真正显示在选项下方；接 `ctx.signal` 支持取消；无否定选项时兜底追加「取消」；
  新增 `rememberKey`（可选"记住这次选择"，配套命令「清除记住的确认选择」）；`secrets.get` 加 `beeCode.apiKey.*` 白名单
- **新增三个检索工具（协议 v7）**：
  `symbols.search`（全工作区按名字找定义，优先 workspace/symbol，无 provider 时 grep+outline 兜底并标注 `source: fallback`）、
  `symbols.references`（executeReferenceProvider，"谁在用它"）、
  `search.grep` 的 `filesOnly` 模式（只回文件+命中次数，召回阶段省一个数量级 token）
- **读文件改为按"返回量"限流**：文件 >512KB 不再整体拒绝，改流式按行读（只读到 `endLine`，内存与文件大小无关）；
  单次返回上限 256KB / 2000 行，超出标 `truncated`；返回 `startLine/endLine`；二进制（前 8KB 含 NUL）直接拒绝；
  `version` 改为可选（磁盘读取不再返回误导性的 0）
- **`fs.list` 先多取再过滤**：修复"前 N 个都被 `.gitignore` 忽略 → 返回空列表"；新增 `truncated`
- **`shell.read_symbol(path, symbol)`**：先 `symbols.outline` 定位再按行范围读，大文件里读单个函数的推荐姿势
- **协议 v5**：`chat.send` 新增可选 `history[]`，重载后「继续」时可带上上下文
- **协议 v3**：`diagnostics.get` 支持 `minSeverity` / `maxItems` / `includeIgnored`，返回 `{items, total, truncated}`；
  每条诊断新增 `code`（`TS2322` 等）与 1-based 列号
- **诊断默认过滤噪声**：`node_modules` / `.git` / 构建产物 / `.gitignore` 里的文件不再进入结果
- **诊断按严重度排序**（error 优先）并默认最多 200 条，避免一次塞爆上下文
- 忽略规则抽成 `src/workspaceIgnore.ts`，由 fs / search / diagnostics 三个适配器共用（之前是两份拷贝，规则容易漂移）
- **diff 预览**：路径改走 `resolveTarget`（不再能借预览读工作区外文件）；虚拟文档内容表加 LRU 上限（50 条 / 20 MB）；
  同一文件重新提案时原地刷新；`openChanges` 统一返回 `{opened}` 并处理失败；scheme 改为 `beecode-xzyk520-base`
- **写入通道**：修好「新建文件」整条路径（`createFile` + `insert` + 自动建父目录）；换行符跟随目标文件（CRLF 不再被写成 LF）；
  有未保存修改的文件拒绝删除；删除后不再返回陈旧 `version`；单次写入上限 2 MB

### Planned

- 内核 `chat.send` 最小闭环（读文件 → 调模型 → 流式吐字）
- 逐函数 Keep/Undo 的状态机（`beecode/pending`）
- MCP 客户端与 Skill 按需加载
- sidecar 打包（PyInstaller）与首次运行引导（`scripts/bootstrap.py`）
- `checkpoint.list` RPC（内核目前无法列出检查点，见 docs §10.5.1）

## [0.0.1] - 2026-10-19

第一个可用骨架：**扩展壳完整、内核仅协议层**。可以在 VS Code 里 F5 起来、配置模型、看到面板；
内核侧的 agent 逻辑尚未实现（`chat.send` 仍返回 `尚未实现`）。

### Added

- **扩展壳**：12 个命令、3 个选区快捷键、活动栏面板（WebviewView + CSP + 消息白名单）
- **模型配置**：`base_url` / `model` / `api_key` 三步向导；密钥只进 `SecretStorage`，经 stdin 握手传给内核
- **配置层**：`readConfig()` 带运行时类型与范围校验，非法值回退默认并记日志
- **内核定位**：`coreLocator` 自动判定工作区（开发）或扩展目录（安装），注入 `PYTHONPATH` 与 UTF-8 相关环境变量
- **RPC 通道**：JSON-RPC 2.0 over NDJSON（`LineReader` 分帧）、请求超时、`$/cancelRequest`、`id` 支持 `number | string`
- **协议契约**：`protocol/contract.json` 作为唯一真相，TS 与 Python 两侧启动时对账（`src/contract.ts` / `beecode/contract.py`）
- **11 个编辑器适配器方法**：`fs.read` `fs.list` `search.grep` `symbols.outline` `diagnostics.get`
  `edit.apply` `checkpoint.create/restore` `diff.open` `confirm.ask` `secrets.get`
- **写入即待审**：`WorkspaceEdit` 单次落盘（一个 undo 单元）+ 版本冲突检测 + 影子 git 检查点
- **影子 git**：`<globalStorage>/shadow.git`，支持 `paths` 轻量快照、历史压缩（`commit-tree` 重写父链 + `gc`）、
  并发串行化、`list()` 从 `git log` 读（重载窗口不丢回滚入口）
- **日志**：双 `LogOutputChannel`（自动落盘、级别可调）+ 6 条凭据脱敏规则 + 500 行内存缓冲
- **诊断包**：`Bee Code: 导出诊断包（已脱敏）`，落 `<globalStorage>/diagnostics/`，可另存
- **Mock 内核**：`beeCode.core.mode = "mock"` 时不装 Python 也能调壳（流式 / pending / 取消）
- 工程化：双 tsconfig（扩展无 DOM / 面板有 DOM）、esbuild 打包（44 KB）、vsce 打包脚本、`.vscodeignore` 清理

### Added

- **内核 M1：能对话**。新增 `session.py`（会话内存态）、`llm/openai.py`（OpenAI 兼容 SSE 流式客户端）、
  `loop/agent.py`（单轮循环）、`prompts/`（三模式系统提示）；`chat.send` 真正调模型并流式推送 `ui.delta`，
  `session.abort` 用 `task.cancel()` 真正取消，`shutdown` 取消在飞回合；同会话并发返回 `SIG_CONFLICT`
- 开发环境补装 `httpx`（内核首次真正联网）

### Changed


- **改动落地范式**：从「内存 Overlay 先审后写」改为工业主流的「写入 + 待审（Keep/Undo）」，理由见 `docs/architecture.md` §14.10
- **技术栈**：Python 内核 + TypeScript 薄壳（README 早期版本是全 TS）
- **日志**：普通 `OutputChannel` → `LogOutputChannel`，换来崩溃后仍可查的落盘能力
- **依赖固定**：`typescript` 固定 6.0.3（= VS Code 内置版本）、`@types/vscode` 固定 1.90.0（= `engines` 地板）

### Fixed

- `git init` 带上 `--work-tree` 导致影子仓库根本建不出来
- 未配置 `user.name/email` 的用户无法创建检查点（改为命令内 `-c` 覆盖身份）
- `checkpoint.list()` 只读内存，重载窗口后回滚入口消失
- 影子仓库只增不减（`gc` 删不掉可达祖先）
- 并发 `create()` 撞 `index.lock`
- 检查点不可用时静默返回空 id（改为 `skipped + reason`）
- `status` / `log` 被双重 dispose（资源释放收敛到 `context.subscriptions` 单一所有者）
- `search.grep` 依赖 proposed API（改为公 API 实现）
- vsix 里混入 `__pycache__` 与多余 tsconfig；`vscode:prepublish` 未走 production（310 KB → 44 KB）

[Unreleased]: https://github.com/xzyk520/code_agent/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/xzyk520/code_agent/releases/tag/v0.0.1
