import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ShellConfig } from "./config";
import type { Logger } from "./log";
import { redact } from "./log";

/**
 * 诊断包导出：把「排查问题需要的信息」打成一份**已脱敏**的 Markdown。
 *
 * 隐私红线（写进文件头，也让用户看得见）：
 *   - **不含** API Key（连 `redact` 都不依赖，压根不读 SecretStorage）
 *   - **不含** prompt 全文、文件内容、待审改动内容
 *   - **不含** 完整工作区路径（只留文件夹名，避免泄露用户名/目录结构）
 *   - baseUrl 只保留 origin（协议+主机+端口），路径与查询参数一律丢弃
 *
 * 落点：`<globalStorage>/diagnostics/`（扩展私有目录，不会被误提交进 git）。
 * 用户想发 issue 时，再由命令提示「另存为…」复制到桌面/文档。
 */
export interface DiagnosticsDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  config: ShellConfig;
  /** 内核实现种类，用于说明当前是 python 还是 mock */
  coreKind: string;
}

export async function exportDiagnostics(deps: DiagnosticsDeps): Promise<vscode.Uri> {
  const { context, logger, config, coreKind } = deps;
  const now = new Date();
  const stamp = formatStamp(now);
  const fileName = `bee-code-diagnostics-${stamp}.md`;

  const dir = vscode.Uri.joinPath(context.globalStorageUri, "diagnostics");
  await vscode.workspace.fs.createDirectory(dir);
  const target = vscode.Uri.joinPath(dir, fileName);

  const body = render({ context, logger, config, coreKind, now });
  await vscode.workspace.fs.writeFile(target, Buffer.from(body, "utf8"));
  logger.info(`诊断包已生成：${fileName}（${Math.round(body.length / 1024)} KB）`);
  return target;
}

interface RenderInput extends DiagnosticsDeps {
  now: Date;
}

function render(input: RenderInput): string {
  const { context, logger, config, coreKind, now } = input;
  const extVersion = readExtensionVersion(context);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const log = logger.snapshot();
  const stderr = logger.snapshotStderr();

  const lines: string[] = [];
  lines.push("# Bee Code 诊断包", "");
  lines.push(`> 生成时间：${now.toISOString()}`, "");
  lines.push("本文件**已脱敏**：不含 API Key、prompt 全文、文件内容、待审改动，也不含完整工作区路径。", "");

  lines.push("## 环境", "");
  lines.push("| 项 | 值 |", "| --- | --- |");
  lines.push(`| 扩展版本 | ${extVersion} |`);
  lines.push(`| VS Code | ${vscode.version} |`);
  lines.push(`| 平台 | ${process.platform} / ${process.arch} |`);
  lines.push(`| Node | ${process.versions.node} |`);
  lines.push(`| Electron | ${process.versions.electron ?? "-"} |`);
  lines.push(`| 系统内存 | ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB |`);
  lines.push(`| 内核模式 | ${config.coreMode}（${coreKind}） |`);
  lines.push(`| Python | ${path.basename(config.pythonPath)} |`);
  lines.push(`| 解释器参数 | ${config.coreArgs.length > 0 ? config.coreArgs.join(" ") : "-m beecode（默认）"} |`);
  lines.push(`| 工作区数量 | ${folders.length} |`);
  lines.push(`| 工作区名称 | ${folders.map((f) => f.name).join(", ") || "-"} |`);
  lines.push("");

  lines.push("## 配置（已脱敏）", "");
  lines.push("| 项 | 值 |", "| --- | --- |");
  lines.push(`| baseUrl（仅 origin） | ${originOf(config.model.baseUrl)} |`);
  lines.push(`| model | ${config.model.model || "<未配置>"} |`);
  lines.push(`| temperature | ${config.model.temperature} |`);
  lines.push(`| maxOutputTokens | ${config.model.maxOutputTokens} |`);
  lines.push(`| supportsTools | ${config.model.supportsTools} |`);
  lines.push(`| agent.maxSteps | ${config.maxSteps} |`);
  lines.push(`| agent.toolTimeoutMs | ${config.toolTimeoutMs} |`);
  lines.push(`| agent.longToolTimeoutMs | ${config.longToolTimeoutMs} |`);
  lines.push(`| review.granularity | ${config.granularity} |`);
  lines.push(`| checkpoint | enabled=${config.checkpointEnabled}, retention=${config.checkpointRetention} |`);
  lines.push(`| apiKey 是否已配置 | ${config.apiKeyId ? "见 SecretStorage（本文件不读取）" : "-"} |`);
  lines.push("");

  lines.push(`## 主日志（最近 ${log.length} 行）`, "");
  lines.push("```text", ...(log.length > 0 ? log : ["<空>"]), "```", "");

  lines.push(`## 内核 stderr（最近 ${stderr.length} 行）`, "");
  lines.push("```text", ...(stderr.length > 0 ? stderr : ["<空>"]), "```", "");

  lines.push("## 明确未包含", "");
  lines.push("- API Key / 任何凭据（本文件不访问 SecretStorage）");
  lines.push("- 对话 prompt 与模型回复全文");
  lines.push("- 源文件内容与待审改动内容");
  lines.push("- 完整工作区路径（只保留文件夹名）");
  lines.push("");

  return `${redact(lines.join("\n"))}\n`;
}

function readExtensionVersion(context: vscode.ExtensionContext): string {
  const pkg = context.extension?.packageJSON as { version?: unknown } | undefined;
  return typeof pkg?.version === "string" ? pkg.version : "unknown";
}

/** 只保留 origin：协议 + 主机 + 端口。路径/查询参数（可能带 key）全部丢弃。 */
function originOf(baseUrl: string): string {
  if (!baseUrl) return "<未配置>";
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<非合法 URL>";
  }
}

function formatStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
