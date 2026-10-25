# 发布 Bee Code

本文覆盖 GitHub 发布与 VS Code Marketplace 上架。

## 1. 版本

在 `package.json` 中修改：

```json
"version": "1.0.0"
```

同时确认：

- `pyproject.toml` 的 `version`
- `beecode/__init__.py` 的 `__version__`
- `CHANGELOG.md` 增加对应版本

## 2. 构建平台运行时

Windows：

```bash
npm run bundle:python
npm run build
npm run package:win
```

macOS：

```bash
npm run bundle:python
npm run build
npm run package:mac
```

Linux：

```bash
npm run bundle:python
npm run build
npm run package:linux
```

输出：

```text
dist-vsix/bee-code-<version>-win32-x64.vsix
dist-vsix/bee-code-<version>-darwin-arm64.vsix
dist-vsix/bee-code-<version>-linux-x64.vsix
```

不要把一个包含三套 runtime 的包发布到 Marketplace；应使用平台专用包。

## 3. GitHub 发布

```bash
git add -A
git commit -m "release: v1.0.0"
git tag -a v1.0.0 -m "Bee Code v1.0.0"
git push origin main
git push origin v1.0.0
```

推送 `v*` tag 后，`.github/workflows/release-vsix.yml` 会在三个原生 runner 上构建并上传三个 VSIX artifact。

在 GitHub 的 **Releases** 页面创建 Release，附上三个 VSIX。

## 4. GitHub 仓库 About

GitHub 的 About 不能通过普通 `git push` 设置，需要在仓库页面：

```text
Settings → General → Description / Topics
```

推荐：

```text
Description: BYO-model coding agent for VS Code. Three modes, per-file proposal approval, bundled Python, Skills and MCP.
Topics: vscode-extension, coding-agent, ai, agents, mcp, skills, deepseek, openai-compatible, typescript, python
```

有 `gh` CLI 且已登录时也可以：

```bash
gh repo edit xzyk520/code_agent   --description "BYO-model coding agent for VS Code. Three modes, per-file proposal approval, bundled Python, Skills and MCP."   --add-topic vscode-extension --add-topic coding-agent --add-topic ai --add-topic agents   --add-topic mcp --add-topic skills --add-topic deepseek --add-topic openai-compatible   --add-topic typescript --add-topic python
```

## 5. 创建 Marketplace Publisher

打开：

https://marketplace.visualstudio.com/manage

创建 Publisher。`package.json` 中的：

```json
"publisher": "xzyk"
```

必须与 Publisher ID 一致；否则发布失败。

## 6. 创建 Azure DevOps PAT

打开：

https://dev.azure.com

```text
User settings → Personal access tokens → New Token
```

权限：

```text
Marketplace → Manage
```

复制 Token，只保存一次。

## 7. 登录 vsce

```bash
npx @vscode/vsce login xzyk
```

或使用环境变量：

```powershell
$env:VSCE_PAT="<your-pat>"
```

## 8. 发布 Windows 包

```bash
npx @vscode/vsce publish --packagePath dist-vsix/bee-code-1.0.0-win32-x64.vsix --target win32-x64
```

## 9. 发布 macOS / Linux 包

下载对应平台的 VSIX 后：

```bash
npx @vscode/vsce publish --packagePath bee-code-1.0.0-darwin-arm64.vsix --target darwin-arm64
npx @vscode/vsce publish --packagePath bee-code-1.0.0-linux-x64.vsix --target linux-x64
```

也可以在对应操作系统上直接：

```bash
npm run bundle:python
npm run package:mac
npx @vscode/vsce publish --target darwin-arm64
```

## 9.1 GitHub Actions 自动发布（免下载）

在 GitHub 仓库添加 Secret：

```text
Settings → Secrets and variables → Actions
→ New repository secret
Name: VSCE_PAT
Value: <Azure DevOps PAT>
```

PAT 权限：

```text
Marketplace → Manage
```

workflow：

```text
.github/workflows/release-vsix.yml
```

有两个触发方式：

### 推送 v* tag

```bash
git tag v1.0.0
git push origin v1.0.0
```

会自动：

```text
构建三平台 VSIX
→ 创建 GitHub Release
→ 发布到 VS Code Marketplace
```

### 手动运行

GitHub Actions → Build platform VSIX → Run workflow：

```text
publish_marketplace: true
```

也会构建并发布，不需要把 100MB 的 Linux 包下载到本地。

如果没有配置 `VSCE_PAT`，发布 job 会失败；构建和 GitHub Release 仍然不受影响。

## 10. 版本冲突

Marketplace 拒绝重复版本：

```text
The version 1.0.0 already exists
```

此时修改版本为 `1.0.1`，更新 `CHANGELOG.md`，重新构建并发布。

## 11. 发布前检查

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `python -m compileall -q beecode` 通过
- [ ] 版本号三处一致
- [ ] `README.md` / `LICENSE` 存在
- [ ] VSIX 含 `runtime/<platform>` 和 `beecode/`
- [ ] VSIX 不含 `tests/`
- [ ] 没有 `.beecode/mcp.json` 或 API Key
- [ ] `publisher` 与 Marketplace 一致
- [ ] 三个平台分别测试安装

## 12. 平台支持

| 平台 | Marketplace target | 内置 Python |
| --- | --- | --- |
| Windows x64 | `win32-x64` | 官方 embeddable |
| macOS ARM64 | `darwin-arm64` | python-build-standalone |
| Linux x64 | `linux-x64` | python-build-standalone |
| macOS Intel | 暂无独立包 | 系统 Python / `Set up Python core` |
