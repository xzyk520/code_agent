# 用户验收测试

这份清单面向“把 Bee Code 当产品用”的测试，不要求读源码。

## 0. 准备

- VS Code `^1.90`
- Node.js 20+
- Python 3.11（推荐 conda 环境）
- 一个**临时测试工作区**（建议先 `git init`，不要用重要仓库）
- 一个 OpenAI 兼容模型端点和 API Key

```bash
npm install
npm run typecheck
npm run build
```

### 开发宿主方式

用 VS Code 打开本仓库，按 `F5`，在“Extension Development Host”窗口里测试。

### VSIX 安装方式

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension bee-code-0.1.0.vsix
```

安装版需要额外配置 Python：

```json
{
  "beeCode.core.pythonPath": "D:\\path\\to\\python.exe",
  "beeCode.core.coreRoot": "D:\\path\\to\\bee-code"
}
```

`coreRoot` 指向包含 `beecode/` 的目录。开发宿主模式通常能自动找到工作区里的 `beecode/`。

## 1. 模型配置

命令面板运行：

```text
Bee Code: Configure model (base_url / key / model)
```

填写：

```text
base_url: https://api.deepseek.com/v1
model:    deepseek-chat
api_key:  <your key>
```

然后运行：

```text
Bee Code: Test model connection
```

预期：提示连接成功；密钥只写入 `SecretStorage`，不会出现在 `settings.json`。

## 2. 基础对话

在侧边栏打开 **Bee Code → Agent**，发送：

```text
你好，用三句话介绍这个项目。
```

预期：

- 模型流式输出；
- 停止按钮可用；
- 状态栏从 busy 回到 idle；
- 刷新窗口后会话仍可恢复。

## 3. 只读工具

发送：

```text
读取 README.md，告诉我这个项目是做什么的。
```

预期：

- 模型调用 `read_file`；
- 编辑器出现读取范围高亮（短暂）；
- 回答里有 `README.md` 依据。

## 4. 写入与待审提案

在一个测试工作区里发送：

```text
新建文件 hello.txt，内容是一行 hello bee code。
```

预期：

1. 模型生成提案，不直接写盘；
2. 面板出现待审卡片；
3. 点击 **Accept** 后文件才出现；
4. 点击 **Reject** 则文件不出现；
5. 接受后运行：

```text
Bee Code: Restore checkpoint…
```

可以回滚本轮改动。

### 选择性接受

一次让模型改两个文件：

```text
新建 a.txt 和 b.txt，各写一行测试内容。
```

只接受 `a.txt`，拒绝 `b.txt`，确认：

- `a.txt` 存在；
- `b.txt` 不存在；
- 检查点只回滚已接受的改动。

## 5. 命令执行与审批

在测试工作区发送：

```text
运行 ping -n 3 127.0.0.1（Windows）或 ping -c 3 127.0.0.1（macOS/Linux）。
```

预期：

- 出现命令审批；
- 审批后看到命令输出；
- 只读命令在无 Docker 时走“受限只读”审批；
- 写命令/危险命令会要求 host 审批并创建命令级 checkpoint；
- 拒绝后模型收到拒绝原因。

## 6. 后台长命令

发送：

```text
运行 `node -e "setTimeout(()=>console.log('done'), 8000)"`，不要一直等；如果超过 2 秒就放后台，然后继续做别的事。
```

预期：

- 前台等待上限约 120 秒，但模型可以选择继续等待；
- 超时后进入后台；
- 模型可调用 `command_list` 查看；
- 可用 `command_wait` 等待、`command_terminate` 终止；
- 面板出现后台任务提示，取消后不再重复提示。

## 7. 重试与续写

- 拔网/让模型端点不可用，发送消息；
- 观察重试提示与 **Retry** 按钮；
- 恢复网络后点击 Retry；
- 中途断流时观察保留的部分输出和“继续”行为。

## 8. 会话

- 运行 `Bee Code: New session`；
- 运行 `Bee Code: History sessions…` 切回旧会话；
- 刷新窗口，确认会话仍可恢复；
- 确认旧会话标题不会全部变成“新会话”。

## 9. 语言

命令面板运行：

```text
Bee Code: Switch language
```

切换 English / 中文，确认：

- 面板按钮和提示切换；
- 命令标题保持英文；
- 模型提示词始终英文，但模型回复跟随用户语言。

## 10. Skills

创建：

```text
demo-skill/
└─ SKILL.md
```

`SKILL.md` 示例：

```markdown
---
name: demo-skill
description: Use when the user asks for a concise test plan.
---

# Demo skill

When asked for a test plan, return exactly three numbered items.
```

在 **Skills & MCP** 视图：

- 拖入整个 `demo-skill` 文件夹，或点击 **Choose skill folder…**；
- 确认列表出现 `demo-skill`；
- 发送：

```text
Use demo-skill to give me a test plan.
```

预期：

- 系统提示词出现 skill 索引；
- 模型调用 `read_skill`；
- 回答遵循 `SKILL.md` 的指令；
- 删除 skill 后列表消失。

## 11. MCP

先准备一个本地 stdio MCP 服务器（避免依赖网络）。保存为 `mcp_echo.py`：

```python
import json
import sys

for line in sys.stdin:
    try:
        message = json.loads(line)
    except Exception:
        continue
    method = message.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "echo", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{
            "name": "echo",
            "description": "Echo text",
            "inputSchema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"]
            }
        }]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": message["params"]["arguments"].get("text", "")}]}
    else:
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
```

准备 `mcp.json`：

```json
{
  "mcpServers": {
    "echo": {
      "command": "python",
      "args": ["D:/path/to/mcp_echo.py"]
    }
  }
}
```

在 **Skills & MCP** 视图拖入或选择 `mcp.json`。发送：

```text
Use the echo MCP tool to echo "hello bee code".
```

预期：

- 日志出现 `MCP server echo ready: 1 tools`；
- 模型可用工具 `mcp__echo__echo`；
- 返回内容包含 `hello bee code`。

## 12. 沙箱与信任

在测试工作区分别测试：

- `beeCode.workspace.trust` 切换到不可信：写文件/命令被拒绝；
- 权限模式 `readonly`：禁止写；
- `manual`：逐次确认；
- `acceptEdits`：写自动接受，命令仍需确认；
- `auto`：低风险自动放行；
- `bypass`：仅在容器/虚拟机里测试。

Docker 可选；没有 Docker 时：

- 只读命令走严格白名单；
- 写命令走 host 审批 + checkpoint；
- 确认拒绝路径不会执行命令。

## 13. 诊断

运行：

```text
Bee Code: Export diagnostics (redacted)
```

预期：生成诊断文件，包含配置、协议、日志摘要，但不包含 API Key。

## 14. 建议的验收顺序

```text
模型连接 → 基础对话 → 读文件 → 提案接受/拒绝 → checkpoint
→ 命令审批 → 后台任务 → 重试 → 会话 → 语言
→ Skills → MCP → 沙箱/信任 → 诊断
```

## 15. 常见问题

- **找不到内核**：设置 `beeCode.core.coreRoot`，确认目录下有 `beecode/`。
- **Python 报错**：设置绝对 `pythonPath`，确认 `pip install -e ".[dev]"` 已执行。
- **MCP 没启动**：看 **Show logs**；确认命令可执行、路径是绝对路径、JSON 合法。
- **拖入文件夹没反应**：用 **Choose skill folder…** 作为回退。
- **命令一直不出结果**：查看后台任务提示；用 `command_list` / `command_wait`。
- **模型不调用工具**：确认端点支持 function calling；在设置里检查 `beeCode.model.nativeTools`。

## 16. 安全提醒

- 只测试你信任的 MCP server；它会以你的用户权限执行命令。
- `mcp.json` 可能包含环境变量密钥，已被 `.gitignore` 忽略。
- 不要在重要仓库首次测试写入/命令能力；先用临时目录。
