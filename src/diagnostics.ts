import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ShellConfig } from "./config";
import type { Logger } from "./log";
import { redact } from "./log";

/**
 * Diagnostics export: package "the information needed to troubleshoot" into a **redacted** Markdown file.
 *
 * Privacy red lines (written into the file header so the user can see them too):
 *   - **No** API Key (not even `redact` is relied on; SecretStorage is never read at all)
 *   - **No** full prompt text, file contents, or pending-change contents
 *   - **No** full workspace paths (only the folder name, to avoid leaking user names/directory structure)
 *   - baseUrl keeps only the origin (scheme + host + port); paths and query parameters are dropped entirely
 *
 * Location: `<globalStorage>/diagnostics/` (an extension-private directory that will not be committed to git by accident).
 * If the user wants to file an issue, the command then offers "Save As..." to copy it to the Desktop/Documents.
 */
export interface DiagnosticsDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  config: ShellConfig;
  /** Kind of kernel implementation, to state whether it is python or mock */
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
  logger.info(`Diagnostics bundle created: ${fileName} (${Math.round(body.length / 1024)} KB)`);
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
  lines.push("# Bee Code Diagnostics", "");
  lines.push(`> Generated at: ${now.toISOString()}`, "");
  lines.push("This file is **redacted**: it contains no API keys, full prompts, file contents, pending changes, or full workspace paths.", "");

  lines.push("## Environment", "");
  lines.push("| Item | Value |", "| --- | --- |");
  lines.push(`| Extension version | ${extVersion} |`);
  lines.push(`| VS Code | ${vscode.version} |`);
  lines.push(`| Platform | ${process.platform} / ${process.arch} |`);
  lines.push(`| Node | ${process.versions.node} |`);
  lines.push(`| Electron | ${process.versions.electron ?? "-"} |`);
  lines.push(`| System memory | ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB |`);
  lines.push(`| Core mode | ${config.coreMode} (${coreKind}) |`);
  lines.push(`| Python | ${path.basename(config.pythonPath)} |`);
  lines.push(`| Interpreter arguments | ${config.coreArgs.length > 0 ? config.coreArgs.join(" ") : "-m beecode (default)"} |`);
  lines.push(`| Workspace count | ${folders.length} |`);
  lines.push(`| Workspace names | ${folders.map((f) => f.name).join(", ") || "-"} |`);
  lines.push("");

  lines.push("## Configuration (redacted)", "");
  lines.push("| Item | Value |", "| --- | --- |");
  lines.push(`| baseUrl (origin only) | ${originOf(config.model.baseUrl)} |`);
  lines.push(`| model | ${config.model.model || "<not configured>"} |`);
  lines.push(`| temperature | ${config.model.temperature} |`);
  lines.push(`| maxOutputTokens | ${config.model.maxOutputTokens} |`);
  lines.push(`| supportsTools | ${config.model.supportsTools} |`);
  lines.push(`| agent.maxSteps | ${config.maxSteps} |`);
  lines.push(`| agent.toolTimeoutMs | ${config.toolTimeoutMs} |`);
  lines.push(`| agent.longToolTimeoutMs | ${config.longToolTimeoutMs} |`);
  lines.push(`| review.granularity | ${config.granularity} |`);
  lines.push(`| checkpoint | enabled=${config.checkpointEnabled}, retention=${config.checkpointRetention} |`);
  lines.push(`| apiKey configured | ${config.apiKeyId ? "See SecretStorage (not read by this file)" : "-"} |`);
  lines.push("");

  lines.push(`## Main log (last ${log.length} lines)`, "");
  lines.push("```text", ...(log.length > 0 ? log : ["<empty>"]), "```", "");

  lines.push(`## Core stderr (last ${stderr.length} lines)`, "");
  lines.push("```text", ...(stderr.length > 0 ? stderr : ["<empty>"]), "```", "");

  lines.push("## Explicitly excluded", "");
  lines.push("- API keys / any credentials (this file does not access SecretStorage)");
  lines.push("- Full conversation prompts and model replies");
  lines.push("- Source file contents and pending changes");
  lines.push("- Full workspace paths (folder names only)");
  lines.push("");

  return `${redact(lines.join("\n"))}\n`;
}

function readExtensionVersion(context: vscode.ExtensionContext): string {
  const pkg = context.extension?.packageJSON as { version?: unknown } | undefined;
  return typeof pkg?.version === "string" ? pkg.version : "unknown";
}

/** Keep only the origin: scheme + host + port. Paths/query parameters (which may carry a key) are dropped entirely. */
function originOf(baseUrl: string): string {
  if (!baseUrl) return "<not configured>";
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<invalid URL>";
  }
}

function formatStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
