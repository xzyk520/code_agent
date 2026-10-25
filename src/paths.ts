import * as path from "node:path";
import * as vscode from "vscode";

/**
 * The **single authority** for path policy lives on the shell side (README §4.5.4 item 3).
 *
 * A path coming from the kernel may be "made up by the model", so validate it independently:
 *   - it must be inside some workspace root (prevent ../ traversal and symlink escapes)
 *   - it must not hit the forbidden list (.git / .env / private keys etc.)
 *
 * Note: this is one layer of "defence in depth"; the kernel side should validate too. Only doing both
 * counts as depth.
 */

const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules", ".venv", "__pycache__"]);

const FORBIDDEN_FILE_PATTERNS: RegExp[] = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_(rsa|ed25519|ecdsa)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

/** Resolve the relative/absolute path given by the kernel into a Uri and check the boundary */
/**
 * Roots outside the workspace that the user has explicitly approved (in-memory, not persisted).
 *
 * Purpose: once the user allows an "outside workspace path", add its directory here so later access
 * to the same directory does not prompt again. Gone after a restart (conservative).
 */
const approvedRoots = new Set<string>();

export function addApprovedRoot(dir: string): void {
  approvedRoots.add(path.resolve(dir));
}

export function clearApprovedRoots(): void {
  approvedRoots.clear();
}

export function isApprovedRoot(target: string): boolean {
  const resolved = path.resolve(target);
  for (const root of approvedRoots) {
    if (resolved === root || isInside(root, resolved)) return true;
  }
  return false;
}

export function resolveTarget(rawPath: string): vscode.Uri {
  if (!rawPath || typeof rawPath !== "string") {
    throw new PathPolicyError("path 不能为空");
  }
  if (rawPath.includes("\0")) {
    throw new PathPolicyError("path 含非法字符");
  }

  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => path.resolve(f.uri.fsPath));
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(roots[0] ?? process.cwd(), rawPath);

  const inside = roots.some((root) => isInside(root, candidate));
  if (!inside) {
    // Directories the user explicitly approved (outside the workspace) are allowed through; the rest are still rejected
    if (!isApprovedRoot(candidate)) {
      throw new PathPolicyError(`路径越界（不在工作区内）：${rawPath}`);
    }
  }

  const normalized = candidate.split(/[\\/]+/).map((s) => s.toLowerCase());
  for (const seg of FORBIDDEN_SEGMENTS) {
    if (normalized.includes(seg)) {
      throw new PathPolicyError(`禁止访问该目录：${seg}`);
    }
  }
  const base = path.basename(candidate);
  if (FORBIDDEN_FILE_PATTERNS.some((re) => re.test(base))) {
    throw new PathPolicyError(`禁止访问敏感文件：${base}`);
  }

  return vscode.Uri.file(candidate);
}

/** Boundary check only, never throws (for soft-filtering cases such as "list/search") */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Normalize to a workspace-relative path (forward slashes) for the kernel and the UI */
export function toWorkspaceRelative(absPath: string): string {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => path.resolve(f.uri.fsPath));
  for (const root of roots) {
    if (isInside(root, absPath)) {
      return path.relative(root, absPath).split(path.sep).join("/");
    }
  }
  return absPath.split(path.sep).join("/");
}
