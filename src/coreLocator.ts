import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Kernel location: decides "which Python package to use, which directory to start from, and with what arguments".
 *
 * Why this is needed: during development the kernel lives in the **workspace** (`<repo>/beecode`), while
 * after packaging it lives in the **extension directory** (`<ext>/beecode`). If we simply hardcoded
 * `cwd=workspaceFolder`, an installed vsix would hit `ModuleNotFoundError: beecode` -- which is exactly
 * why the packaged build did not run before.
 *
 * Resolution order (first hit wins):
 *   1. An explicit `beeCode.core.coreRoot` setting
 *   2. `beecode/__main__.py` under the workspace root (development mode)
 *   3. `beecode/__main__.py` under the extension directory (install mode)
 */

export interface CoreLaunchSpec {
  /** Directory containing the `beecode/` package (goes into PYTHONPATH) */
  coreRoot: string;
  /** Arguments passed to the interpreter (default `-m beecode`) */
  args: string[];
  /** Child process working directory */
  cwd: string;
  /** Environment variables to add/override */
  env: Record<string, string>;
  /** Which source matched, used for logging and troubleshooting */
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
  /** Value of `beeCode.core.coreRoot`; empty string means auto-detect */
  configuredRoot: string;
  /** Value of `beeCode.core.args`; empty array means the default `["-m","beecode"]` */
  configuredArgs: string[];
  /** Absolute path of the first workspace root; undefined when there is no workspace */
  workspaceRoot: string | undefined;
  /** Extension install directory (`context.extensionUri.fsPath`) */
  extensionPath: string;
  /** Resolved value of `beeCode.core.cwd`; empty string means use workspaceRoot ?? coreRoot */
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

  // PYTHONPATH is the key here: `-m beecode` needs the package on sys.path, and in install mode the
  // copy inside the workspace is not available.
  const existingPath = process.env["PYTHONPATH"];
  const pythonPath = existingPath ? `${coreRoot}${path.delimiter}${existingPath}` : coreRoot;

  return {
    coreRoot,
    args,
    cwd,
    source,
    env: {
      PYTHONPATH: pythonPath,
      // On Windows Python's stdio default may be cp936, which turns Chinese JSON into mojibake
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1",
    },
  };
}

/** One-line description for the panel/log */
export function describeLaunch(spec: CoreLaunchSpec): string {
  return `${path.basename(spec.coreRoot)} [${spec.source}] ${spec.args.join(" ")}`;
}
