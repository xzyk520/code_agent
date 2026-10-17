import * as path from "node:path";
import * as vscode from "vscode";

/**
 * 路径策略的**唯一权威**在壳这一侧（README §4.5.4 第 3 条）。
 *
 * 内核传来的 path 可能是「模型编造的」，所以要独立校验：
 *   - 必须在某个工作区根之内（防止 ../ 穿越、符号链接逃逸）
 *   - 不允许命中禁止清单（.git / .env / 私钥等）
 *
 * 注意：这里是「纵深防御」的一环，内核侧也应校验；两边都做才叫纵深。
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

/** 把内核给的相对/绝对路径解析成 Uri，并做边界校验 */
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
    throw new PathPolicyError(`路径越界（不在工作区内）：${rawPath}`);
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

/** 仅做边界判断，不抛错（给「列表/搜索」这种软过滤场景用） */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 统一成工作区相对路径（正斜杠），给内核与 UI 用 */
export function toWorkspaceRelative(absPath: string): string {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => path.resolve(f.uri.fsPath));
  for (const root of roots) {
    if (isInside(root, absPath)) {
      return path.relative(root, absPath).split(path.sep).join("/");
    }
  }
  return absPath.split(path.sep).join("/");
}
