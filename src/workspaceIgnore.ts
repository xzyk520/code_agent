import * as fs from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";
import * as vscode from "vscode";

/**
 * 工作区文件过滤（路径噪声 + `.gitignore`）。
 *
 * 为什么单独一个模块：fs / search / diagnostics 三个适配器都需要同一套判断，
 * 之前 fsAdapter 与 searchAdapter 各抄了一份 `buildGitignoreMatcher`，
 * 再加 diagnostics 就是三份 —— 规则一旦不同步，就会出现「搜索搜不到、诊断却报出来」的诡异现象。
 */

/** 与 `paths.ts` 的禁止目录保持一致，另外补上常见构建产物 */
const NOISE_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "out",
  "build",
  ".next",
  "target",
  "coverage",
]);

export interface IgnoreMatcher {
  /** 绝对路径是否应被跳过（噪声目录 或 .gitignore 命中） */
  ignores(absolutePath: string): boolean;
}

/** 纯路径判断：不读磁盘，用于快速排除 node_modules/.git/构建产物 */
export function isNoisePath(absolutePath: string): boolean {
  const segments = absolutePath.split(/[\\/]+/).map((s) => s.toLowerCase());
  return segments.some((seg) => NOISE_SEGMENTS.has(seg));
}

interface CachedMatcher {
  mtimeMs: number;
  size: number;
  matcher: Ignore;
}

const cache = new Map<string, CachedMatcher>();

/**
 * 读取工作区根的 `.gitignore` 并构造匹配器（带缓存，按 mtime+size 失效）。
 *
 * 已知限制：只读**根**的 `.gitignore`，子目录里的暂不支持（见 README）。
 */
export function buildGitignoreMatcher(root?: string): Ignore | undefined {
  const workspaceRoot = root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return undefined;

  const file = path.join(workspaceRoot, ".gitignore");
  try {
    const stat = fs.statSync(file);
    const cached = cache.get(workspaceRoot);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.matcher;
    }
    const matcher = ignore().add(fs.readFileSync(file, "utf8"));
    cache.set(workspaceRoot, { mtimeMs: stat.mtimeMs, size: stat.size, matcher });
    return matcher;
  } catch {
    cache.delete(workspaceRoot);
    return undefined;
  }
}

/**
 * 统一入口：这个绝对路径要不要跳过？
 *
 * 先做零成本的段名判断，再查 `.gitignore`（缓存过，成本也很低）。
 */
export function isIgnored(absolutePath: string, root?: string): boolean {
  if (isNoisePath(absolutePath)) return true;

  const workspaceRoot = root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return false;

  const matcher = buildGitignoreMatcher(workspaceRoot);
  if (!matcher) return false;

  const rel = path.relative(workspaceRoot, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;   // 工作区外不判断
  return matcher.ignores(rel.split(path.sep).join("/"));
}
