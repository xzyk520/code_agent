import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 内核定位：决定「用哪个 Python 包、从哪个目录起、带什么参数」。
 *
 * 为什么需要它：开发时内核在**工作区**里（`<repo>/beecode`），打包后内核在
 * **扩展目录**里（`<ext>/beecode`）。如果只写死 `cwd=workspaceFolder`，
 * 装好的 vsix 会 `ModuleNotFoundError: beecode` —— 这正是之前打包版跑不起来的原因。
 *
 * 解析顺序（第一个命中的胜出）：
 *   1. `beeCode.core.coreRoot` 显式设置
 *   2. 工作区根下的 `beecode/__main__.py`（开发模式）
 *   3. 扩展目录下的 `beecode/__main__.py`（安装模式）
 */

export interface CoreLaunchSpec {
  /** 含 `beecode/` 包的目录（要进 PYTHONPATH） */
  coreRoot: string;
  /** 传给解释器的参数（默认 `-m beecode`） */
  args: string[];
  /** 子进程工作目录 */
  cwd: string;
  /** 追加/覆盖的环境变量 */
  env: Record<string, string>;
  /** 命中的来源，用于日志与排障 */
  source: "setting" | "workspace" | "extension";
}

export class CoreNotFoundError extends Error {
  constructor(searched: string[]) {
    super(
      `找不到内核（beecode 包）。已查找：\n  ${searched.join("\n  ")}\n` +
        `请在工作区开发内核，或设置 beeCode.core.coreRoot 指向包含 beecode/ 的目录。`,
    );
    this.name = "CoreNotFoundError";
  }
}

export interface LocateOptions {
  /** `beeCode.core.coreRoot` 的值，空串表示自动探测 */
  configuredRoot: string;
  /** `beeCode.core.args` 的值，空数组表示用默认 `["-m","beecode"]` */
  configuredArgs: string[];
  /** 第一个工作区根的绝对路径；没有工作区时传 undefined */
  workspaceRoot: string | undefined;
  /** 扩展安装目录（`context.extensionUri.fsPath`） */
  extensionPath: string;
  /** `beeCode.core.cwd` 解析后的值；空串表示用 workspaceRoot ?? coreRoot */
  cwdOverride?: string;
}

const PACKAGE_ENTRY = path.join("beecode", "__main__.py");

export function locateCore(options: LocateOptions): CoreLaunchSpec {
  const searched: string[] = [];

  const candidates: Array<{ root: string; source: CoreLaunchSpec["source"] }> = [];
  if (options.configuredRoot && options.configuredRoot.trim().length > 0) {
    candidates.push({ root: path.resolve(options.configuredRoot.trim()), source: "setting" });
  } else {
    if (options.workspaceRoot) candidates.push({ root: options.workspaceRoot, source: "workspace" });
    candidates.push({ root: options.extensionPath, source: "extension" });
  }

  for (const candidate of candidates) {
    const entry = path.join(candidate.root, PACKAGE_ENTRY);
    searched.push(entry);
    if (fs.existsSync(entry)) {
      return buildSpec(candidate.root, candidate.source, options);
    }
  }

  throw new CoreNotFoundError(searched);
}

function buildSpec(
  coreRoot: string,
  source: CoreLaunchSpec["source"],
  options: LocateOptions,
): CoreLaunchSpec {
  const args = options.configuredArgs.length > 0 ? [...options.configuredArgs] : ["-m", "beecode"];
  const cwd = options.cwdOverride && options.cwdOverride.trim().length > 0
    ? options.cwdOverride
    : options.workspaceRoot ?? coreRoot;

  // PYTHONPATH 是这里的关键：`-m beecode` 需要包在 sys.path 上，
  // 而安装模式下拿不到工作区里的那份拷贝。
  const existingPath = process.env["PYTHONPATH"];
  const pythonPath = existingPath ? `${coreRoot}${path.delimiter}${existingPath}` : coreRoot;

  return {
    coreRoot,
    args,
    cwd,
    source,
    env: {
      PYTHONPATH: pythonPath,
      // Windows 上 Python 的 stdio 默认可能是 cp936，会让中文 JSON 变乱码
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1",
    },
  };
}

/** 供面板/日志展示的一句话描述 */
export function describeLaunch(spec: CoreLaunchSpec): string {
  return `${path.basename(spec.coreRoot)} [${spec.source}] ${spec.args.join(" ")}`;
}
