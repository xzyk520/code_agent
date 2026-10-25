import * as fs from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";
import * as vscode from "vscode";

/**
 * Workspace file filtering (path noise + `.gitignore`).
 *
 * Why a separate module: the fs / search / diagnostics adapters all need the same judgement, and
 * previously fsAdapter and searchAdapter each had their own copy of `buildGitignoreMatcher`; adding
 * diagnostics would have made three -- and once the rules drift apart you get the bizarre state where
 * "search cannot find it but diagnostics reports it".
 */

/** Kept in sync with the forbidden directories in `paths.ts`, plus the usual build outputs */
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
  /** Whether an absolute path should be skipped (noise directory or a .gitignore hit) */
  ignores(absolutePath: string): boolean;
}

/** Pure path check: does not touch the disk; used to rule out node_modules/.git/build outputs quickly */
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
 * Read the workspace root's `.gitignore` and build a matcher (cached, invalidated by mtime+size).
 *
 * Known limitation: only the **root** `.gitignore` is read; ones in subdirectories are not supported yet (see README).
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
 * Single entry point: should this absolute path be skipped?
 *
 * Do the zero-cost segment check first, then consult `.gitignore` (cached, so also cheap).
 */
export function isIgnored(absolutePath: string, root?: string): boolean {
  if (isNoisePath(absolutePath)) return true;

  const workspaceRoot = root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return false;

  const matcher = buildGitignoreMatcher(workspaceRoot);
  if (!matcher) return false;

  const rel = path.relative(workspaceRoot, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;   // outside the workspace: no judgement
  return matcher.ignores(rel.split(path.sep).join("/"));
}
