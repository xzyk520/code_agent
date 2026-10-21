# Changelog

本文件记录所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-19

### Added

- **思考内容抓取（协议 v27）**：
  - 解析 `reasoning_content` / `reasoning` / `thinking`，经 `ui.reasoning` 在面板显示为可折叠「思考过程」（答题自动收起）
  - 思考内容不进上下文、不进摘要、不落盘；跨轮不会出现
  - 回传策略 `beeCode.model.reasoningReplay`（auto/always/never）：auto 默认不回传，服务端要求时自动补上并重试

- **轨迹增强**：顶部搜索框按意图过滤；Chat/Builder/Debugger 三色区分（圆点 + 左侧色条）；
  旧版轮次记录没有 `userMessageId` 时按 `messageIndex` 回填，老会话同样能重建轨迹

- **计划模板、任务成本与右侧轨迹（协议 v26）**：
  - 大任务自动预置 4 步计划骨架（读 → 改 → 测 → 总结），模型可沿用或重写
  - header 实时显示本轮 token/耗时，超过预算 80% 提示「接近预算」（内核每次模型调用后推送 `ui.usage.elapsedMs`）
  - 面板右侧新增会话轨迹：每轮一条意图，点击平滑跳转到对应消息并高亮；重载/回滚后自动重建

- **长任务可靠性（协议 v25）**：
  - 大任务自动放宽步数（`agent.largeTaskSteps`，默认 24）；单轮新增 token/墙钟预算（200k / 900s），用尽后禁工具收尾
  - 计划持久化：`ui.plan` 落 `turns.jsonl` + `session meta`；重载恢复面板，下一轮作为 system 注入未完成步骤
  - 计划推断：`propose_edit` 成功 → 提到该文件的步骤标 done；接受提案 → 面板/元数据同步勾选
  - `needs_proposal` 轮次开始时自动建检查点，长任务中途可回滚

- **摘要自动持久化**：`<sessions>/<sessionId>.summary.json` 保存 `{covered, coveredMessageIndex, lines}`
  - 会话重载/切换后直接读回摘要，不再重新调用模型计算
  - 聊天回滚时按 `messageIndex` 截断摘要行；会话被外部截短则整体丢弃重算
  - 全程自动：没有手动「压缩」入口

- **轮内压缩与工具观察化（协议 v24）**：
  - 每次模型调用前按 `contextWindow × 70%` 检查 token：旧工具结果折叠成 digest → 丢最早交换 → 模型摘要兜底
  - 新增设置 `beeCode.model.contextWindow`（默认 32768）；用服务端 `usage` EMA 校准估算系数
  - 工具结果整形：`read_file` 头 120/尾 30、`run_command` stdout 头 100/尾 40、`search_code` 每条截 160 字/最多 50 条、
    `list_files` 最多 200、`get_diagnostics` 计数 + 前 20 条
  - 轮次记录新增 `observations`（工具名 + 一行结果），并传入模型摘要作为上下文

- **意图与摘要的三个优化（协议 v23）**：
  - 连续追问（「继续/接着/好/ok」且无附件）沿用上一轮意图，不再调用分类器
  - 模型摘要改为**增量**：只总结新折叠的轮次并追加，摘要超预算时丢弃最旧的行
  - 会话标题改为跟随「最近一次用户意图」

- **意图分析驱动模式（协议 v22）**：
  - 每轮提问都先做分类（chat 语义、非流式、不展示分析内容）；**删除 auto 模式与手动模式按钮**，面板只显示模式徽标
  - 分类输出新增 `intent`（一句话用户意图）；被持久化进 `turns.jsonl`（意图/回答/工具/文件/消息行号）
  - 上下文压缩改为**模型摘要**：内核新增 `context.summarize`，按轮次让主模型输出 `{pairs:[{intent,summary}]}`，
    每条总结必须覆盖「调用了什么工具 / 改动了哪些文件 / 实现了什么需求」
  - 摘要缓存按覆盖轮次数失效；聊天回滚时轮次记录按行号同步截断；模型摘要失败自动退回机械摘要

- **聊天快照只存行号**（不再复制消息）：`<globalStorage>/checkpoints/<id>.json` = `{id, sessionId, line, createdAt}`，约 100 字节
  - 回滚聊天 = 把会话 JSONL 截断到第 `line` 行
  - 截断后上下文自动重建：最后 8 条原样 + 更早的机械摘要 + 一条【回滚通知】系统消息
  - 兼容旧的全文快照格式（自动降级为条数）

- **回滚可选范围（代码 / 代码+聊天）**：
  - 每次创建检查点时同时快照聊天记录（`<globalStorage>/checkpoints/<id>.json`，含消息全文与条数）
  - 回滚时选择「仅回滚代码」或「代码 + 聊天记录一起回滚」；前者追加【回滚通知】系统消息，后者截断会话 JSONL 到快照时刻
  - 目标之后的代码快照与聊天快照**一并作废**（影子仓库 `update-ref HEAD` 回退 + 删除快照文件），新快照从目标点继续
  - 回滚时清空待审提案，避免基于旧代码误点「接受」

- **意图识别改用主模型**（不再硬编码关键词）：
  - 非流式分类调用 + `response_format: json_schema` 强制输出 {mode, scale, needs_proposal, reason}
  - `mode` 固定 chat / builder / debugger；非法值会带着错误信息要求模型重试（最多 2 次）
  - 服务端不支持结构化输出时自动降级（json_object → 纯文本解析）
  - `needs_proposal` 驱动「只说不做」守卫：builder/debugger 默认要求产出提案
  - 分类 token 计入本轮用量；失败退回 chat 并标注「降级判定」（协议 v21）

- **视觉能力不再靠枚举模型名**：
  - `supportsVision: auto` = 乐观先带图尝试；服务端明确拒绝（400/415/422 + image/vision/modality 等措辞）后
    自动剥掉图片重试一次，并记住「该 baseUrl+model 不支持图片」
  - 缓存按 `baseUrl + model` 记，换网关/换模型自动失效；进程内有效
  - 降级时向用户提示（guard + log），后续轮次直接不发图片
  - 删除 28 个模型名片段的启发式枚举

- **点击 chip 跳转后自动高亮**：打开文件并定位后，重新绘制读取范围高亮 6 秒（`addRead` 去重，不会重复叠加）

- **已读取文件 chip 可点击跳转**：点击 `a.ts:10-20` 打开文件并把光标定位到对应行（预览模式，不抢标签页）
  - webview 消息按不可信处理：拒绝绝对路径与 `..`，行号需为有限数字（`parseOpenRead`）
  - 路径仍走 `resolveTarget`，工作区外/禁止清单内一律拒绝

- **高亮跟随（协议 v20）**：模型读文件时广播 `ui.read`
  - 文件已打开 → 在读取范围叠加第二层高亮（与用户光标虚线框区分），6 秒后清除
  - 文件未打开 → 不抢焦点打开，改为面板顶部把**文件名**亮成 chip（含行范围，动效 1.2 秒，最多 8 个）

- **隐式选区高亮**：发送时在编辑器里用虚线框标出 agent 实际读取的代码范围（含函数名），5 秒后自动消失
  - 只对当前可见、路径匹配的编辑器生效；悬停显示读取的行范围
  - 设置 `beeCode.focus.highlight` 可关闭

- **光标上下文（协议 v19）**：提问时自动附上光标所在的**整个函数**
  - 用 LSP `DocumentSymbol` 找最内层函数；不在函数里则取上下 30 行（可配）
  - 函数超过 `beeCode.focus.maxLines`（默认 300）自动退化，避免撑爆上下文
  - 选区落在同一函数内时扩成整个函数；跨函数则保留选区 ±2 行
  - `chat.send` 新增 `focus` 与 `attachment.kind = focus`；内核追加「先看附件，不足再搜」的系统提示
  - 命令「附加选区」在没有选区时也取光标所在函数

- **auto 模式与共享记忆（协议 v18）**：
  - 面板新增 `Auto` 模式（默认）：内核按提问意图自动选择 chat / builder / debugger，并推送 `ui.mode`
  - 意图识别为纯启发式（`beecode/router.py`），不额外调用模型；拿不准归 `chat`
  - 任务规模判定：大任务（长描述/多文件/重构迁移）会提示模型先调用 `update_plan`
  - 新增 `update_plan` 工具 + `ui.plan` 通知；面板渲染可更新的计划清单
  - 三种模式共享同一会话历史（壳按 sessionId 存储），切换模式不丢上下文
  - 设置 `beeCode.mode.default`（auto/chat/builder/debugger）

- **会话仓库**：完整对话按 JSONL 全量落盘（`<globalStorage>/sessions/<id>.jsonl` + `index.json`），
  支持「新建会话」「历史会话…」；重载后自动续上同一个会话，并按「上一轮停在哪」分流：
  模型生成 → 作废并提示；工具调用 → 可「继续上次的操作」；待审提案 → 可「重新生成提案」
- **上下文裁剪**（`src/contextBuilder.ts`）：发给模型的不是整份历史，而是「机械摘要 + 最近 8 条 + token 预算」；
  重载恢复与正常轮次走同一条构建路径（协议 v5 增加 `chat.send.summary`）

- **内核 M1：能对话**。新增 `session.py`（会话内存态）、`llm/openai.py`（OpenAI 兼容 SSE 流式客户端）、
  `loop/agent.py`（单轮循环）、`prompts/`（三模式系统提示）；`chat.send` 真正调模型并流式推送 `ui.delta`，
  `session.abort` 用 `task.cancel()` 真正取消，`shutdown` 取消在飞回合；同会话并发返回 `SIG_CONFLICT`
- 开发环境补装 `httpx`（内核首次真正联网）

- **模型配置体验**：新增命令「测试模型连接」（GET `/models`，报告状态码/耗时/是否包含所配模型）与「清除 API Key」；
  密钥支持 **环境变量兜底** `BEE_CODE_API_KEY`（优先级低于 SecretStorage）；配置向导在已有密钥时允许"直接回车保持不变"

- **权限系统（P1–P3）**：
  - 规则引擎 `src/permissions.ts`：`Read()/Edit()/Run()` 规则，求值顺序 **deny → ask → allow → 模式默认**
  - 五种模式：`plan` / `manual` / `acceptEdits` / `auto` / `bypass`（默认 manual）
  - 工作区信任：首次打开询问一次并记录（`globalState`），不受信任时禁写、禁命令；命令「信任/取消信任此工作区」
  - `run` RPC：cwd 限制、env 清洗、超时 + 进程树 kill、输出 64KB 限幅、非交互、权限门闸
  - docker 沙箱（`sandbox: docker|auto`）：`--network none --read-only --cap-drop ALL`，无 docker 时按配置报错或回退
  - 写入门闸接线：提案接受前校验规则 + 敏感路径二次确认；**接受前自动建检查点**
  - `package.json` 声明 `capabilities.untrustedWorkspaces: "limited"` 与 `virtualWorkspaces: false`

- **沙箱策略细化（协议 v13）**：
  - 启动自动检测 docker：可用则提示一次；不可用只在**首次或配置变化**时询问，之后静默
  - 没有 docker：主代理每条命令都审批（不允许"记住"）；子代理禁止写文件、只能跑只读命令
  - 有 docker：命令**强制**在容器内执行（主/子代理一致）；`fullAccess` 免审批
  - 工作区外路径：主代理需审批、子代理一律拒绝（无论有没有 docker）
  - 未受信任工作区：只读（不变）
  - 新增命令「重新检测 Docker 沙箱」、设置 `beeCode.permissions.fullAccess`；RPC 增加 `role: main|subagent`

- **Agent Loop（M2，协议 v14）**：
  - 工具调用循环：流式解析 `tool_calls` 分片 → 执行 → 结果回灌 → 继续，直到模型给出最终回答
  - 9 个内置工具：`read_file` / `list_files` / `search_code` / `file_outline` / `find_symbol` / `find_references` / `get_diagnostics` / `propose_edit` / `run_command`
  - 守卫：空响应、只说不做、**提前收工**（要改代码却没提案）、重复调用、结果无变化、步数上限
  - 工具超时/异常：错误作为 `tool` 消息回灌模型，同时 `ui.tool(error)` 展示给用户（失败不是崩溃）
  - `propose_edit`：读取当前版本 → 登记提案 → 广播 `proposal.changed`（含 additions/deletions/baseVersion）
  - **视觉能力感知**：`beeCode.model.supportsVision`（auto/on/off），非视觉模型把图片降级为文字说明

- **子代理（spawn_subagent）**：
  - 主代理可派只读子代理探索代码（独立上下文，只回传 ≤8KB 结论）
  - 子代理工具集 8 个只读工具，**没有** `propose_edit` 与 `spawn_subagent`（不允许无限嵌套）
  - 子代理的 `role` 透传给壳（`fs.read` / `run` / `edit.apply`），权限自动收紧：
    工作区外一律拒绝；无 docker 时禁止写与执行非只读命令
  - 父轮次 abort 会级联取消子代理；默认 8 步、上限 12 步

- **子代理独立模型配置**：
  - 新设置 `beeCode.subagent.{enabled,baseUrl,model,apiKeyId,maxSteps,supportsVision}`
  - 端点/模型留空 = 沿用主代理；密钥顺序：SecretStorage → `BEE_CODE_SUBAGENT_API_KEY` → 主代理密钥
  - 新命令：配置子代理模型 / 测试子代理连接 / 清除子代理 API Key
  - 配置变更热更新到内核（`model.reload` 携带 `subagentConfig` + `subagentApiKey`）
- **子代理可视化**：面板新增可折叠的「子代理」卡片（任务标题、工具流水、步数统计、结论预览）
  - 内核新增 `ui.subagent` 通知（`start` / `tool` / `end`，协议 v17）
  - 失败时卡片保持展开并显示原因；同一轮多个子代理按 id 聚合互不干扰

### Security

- `beeCode.model.baseUrl` 与 `apiKeyId` 改为 **machine 作用域**：工作区设置不再能覆盖端点。
  此前一个恶意仓库的 `.vscode/settings.json` 可以把提问、代码和密钥转发到任意地址。

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

- **内核 M1：能对话**。新增 `session.py`（会话内存态）、`llm/openai.py`（OpenAI 兼容 SSE 流式客户端）、
  `loop/agent.py`（单轮循环）、`prompts/`（三模式系统提示）；`chat.send` 真正调模型并流式推送 `ui.delta`，
  `session.abort` 用 `task.cancel()` 真正取消，`shutdown` 取消在飞回合；同会话并发返回 `SIG_CONFLICT`
- 开发环境补装 `httpx`（内核首次真正联网）

- **模型配置体验**：新增命令「测试模型连接」（GET `/models`，报告状态码/耗时/是否包含所配模型）与「清除 API Key」；
  密钥支持 **环境变量兜底** `BEE_CODE_API_KEY`（优先级低于 SecretStorage）；配置向导在已有密钥时允许"直接回车保持不变"

- **权限系统（P1–P3）**：
  - 规则引擎 `src/permissions.ts`：`Read()/Edit()/Run()` 规则，求值顺序 **deny → ask → allow → 模式默认**
  - 五种模式：`plan` / `manual` / `acceptEdits` / `auto` / `bypass`（默认 manual）
  - 工作区信任：首次打开询问一次并记录（`globalState`），不受信任时禁写、禁命令；命令「信任/取消信任此工作区」
  - `run` RPC：cwd 限制、env 清洗、超时 + 进程树 kill、输出 64KB 限幅、非交互、权限门闸
  - docker 沙箱（`sandbox: docker|auto`）：`--network none --read-only --cap-drop ALL`，无 docker 时按配置报错或回退
  - 写入门闸接线：提案接受前校验规则 + 敏感路径二次确认；**接受前自动建检查点**
  - `package.json` 声明 `capabilities.untrustedWorkspaces: "limited"` 与 `virtualWorkspaces: false`

- **沙箱策略细化（协议 v13）**：
  - 启动自动检测 docker：可用则提示一次；不可用只在**首次或配置变化**时询问，之后静默
  - 没有 docker：主代理每条命令都审批（不允许"记住"）；子代理禁止写文件、只能跑只读命令
  - 有 docker：命令**强制**在容器内执行（主/子代理一致）；`fullAccess` 免审批
  - 工作区外路径：主代理需审批、子代理一律拒绝（无论有没有 docker）
  - 未受信任工作区：只读（不变）
  - 新增命令「重新检测 Docker 沙箱」、设置 `beeCode.permissions.fullAccess`；RPC 增加 `role: main|subagent`

- **Agent Loop（M2，协议 v14）**：
  - 工具调用循环：流式解析 `tool_calls` 分片 → 执行 → 结果回灌 → 继续，直到模型给出最终回答
  - 9 个内置工具：`read_file` / `list_files` / `search_code` / `file_outline` / `find_symbol` / `find_references` / `get_diagnostics` / `propose_edit` / `run_command`
  - 守卫：空响应、只说不做、**提前收工**（要改代码却没提案）、重复调用、结果无变化、步数上限
  - 工具超时/异常：错误作为 `tool` 消息回灌模型，同时 `ui.tool(error)` 展示给用户（失败不是崩溃）
  - `propose_edit`：读取当前版本 → 登记提案 → 广播 `proposal.changed`（含 additions/deletions/baseVersion）
  - **视觉能力感知**：`beeCode.model.supportsVision`（auto/on/off），非视觉模型把图片降级为文字说明

- **子代理（spawn_subagent）**：
  - 主代理可派只读子代理探索代码（独立上下文，只回传 ≤8KB 结论）
  - 子代理工具集 8 个只读工具，**没有** `propose_edit` 与 `spawn_subagent`（不允许无限嵌套）
  - 子代理的 `role` 透传给壳（`fs.read` / `run` / `edit.apply`），权限自动收紧：
    工作区外一律拒绝；无 docker 时禁止写与执行非只读命令
  - 父轮次 abort 会级联取消子代理；默认 8 步、上限 12 步

- **子代理独立模型配置**：
  - 新设置 `beeCode.subagent.{enabled,baseUrl,model,apiKeyId,maxSteps,supportsVision}`
  - 端点/模型留空 = 沿用主代理；密钥顺序：SecretStorage → `BEE_CODE_SUBAGENT_API_KEY` → 主代理密钥
  - 新命令：配置子代理模型 / 测试子代理连接 / 清除子代理 API Key
  - 配置变更热更新到内核（`model.reload` 携带 `subagentConfig` + `subagentApiKey`）

### Security

- `beeCode.model.baseUrl` 与 `apiKeyId` 改为 **machine 作用域**：工作区设置不再能覆盖端点。
  此前一个恶意仓库的 `.vscode/settings.json` 可以把提问、代码和密钥转发到任意地址。

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
