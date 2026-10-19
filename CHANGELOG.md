# Changelog

本文件记录所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned

- 内核 `chat.send` 最小闭环（读文件 → 调模型 → 流式吐字）
- 逐函数 Keep/Undo 的状态机（`beecode/pending`）
- MCP 客户端与 Skill 按需加载
- sidecar 打包（PyInstaller）与首次运行引导（`scripts/bootstrap.py`）

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
