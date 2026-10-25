/**
 * Sandbox/permission policy (pure functions).
 *
 * Inputs: whether the workspace is trusted, whether docker is available, whether "full access" is
 *         enabled, whether this is the main agent or a subagent, the action (read/write/run),
 *         whether the target is inside the workspace, and whether the command is read-only.
 * Output: allow / ask / deny + reason.
 *
 * Priority (highest first):
 *   1. Untrusted -> read-only (inside the workspace)
 *   2. Outside the workspace -> always deny for subagents; always ask for the main agent (docker or not)
 *   3. Subagent: without docker, writes and execution are forbidden (except read-only commands); with
 *      docker, execution is allowed
 *   4. Main agent: with docker, execution must go through the sandbox; without docker, every execution
 *      needs approval
 *   5. Full access skips the approvals in 4, but not 1/2
 */

export type AgentRole = "main" | "subagent";
export type PolicyAction = "read" | "write" | "run";

export interface PolicyInput {
  trusted: boolean;
  dockerAvailable: boolean;
  /** The user chose "full access" (only affects approvals; does not lift the outside-workspace/untrusted restrictions) */
  fullAccess: boolean;
  role: AgentRole;
  action: PolicyAction;
  /** Whether the target is inside the workspace (read/write = path, run = cwd) */
  insideWorkspace: boolean;
  /** Only meaningful for run: whether this command was judged read-only (the only commands a subagent may run without a sandbox) */
  readOnlyCommand?: boolean;
}

export interface PolicyDecision {
  decision: "allow" | "ask" | "deny";
  reason: string;
}

export function decide(input: PolicyInput): PolicyDecision {
  // ① Untrusted: read-only, and only inside the workspace
  if (!input.trusted) {
    if (input.action === "read" && input.insideWorkspace) {
      return { decision: "allow", reason: "工作区未受信任：允许读取工作区内文件" };
    }
    return { decision: "deny", reason: "工作区未受信任：只读（禁止写入、执行与工作区外访问）" };
  }

  // ② Outside the workspace: always deny for subagents; always require approval for the main agent (docker or not)
  if (!input.insideWorkspace) {
    if (input.role === "subagent") {
      return { decision: "deny", reason: "子代理不允许操作工作区外的路径" };
    }
    return { decision: "ask", reason: "目标是工作区外的路径，需要你确认" };
  }

  // ③ Subagent
  if (input.role === "subagent") {
    if (input.action === "write") {
      if (!input.dockerAvailable) {
        return { decision: "deny", reason: "没有 docker 沙箱时，子代理不允许写文件" };
      }
      return input.fullAccess
        ? { decision: "allow", reason: "已开放完整权限：子代理可写" }
        : { decision: "ask", reason: "子代理要写文件，需要你确认" };
    }
    if (input.action === "run") {
      if (input.dockerAvailable) {
        return { decision: "allow", reason: "子代理命令将在 docker 沙箱内执行" };
      }
      if (input.readOnlyCommand) {
        return { decision: "allow", reason: "没有 docker 时，子代理只允许执行只读命令" };
      }
      return { decision: "deny", reason: "没有 docker 沙箱时，子代理不允许执行会修改系统的命令" };
    }
    return { decision: "allow", reason: "子代理读取工作区文件" };
  }

  // ④ Main agent
  if (input.action === "run") {
    if (input.fullAccess) {
      return {
        decision: "allow",
        reason: input.dockerAvailable ? "已开放完整权限：命令在 docker 沙箱内执行" : "已开放完整权限：命令直接执行",
      };
    }
    return {
      decision: "ask",
      reason: input.dockerAvailable ? "命令将在 docker 沙箱内执行，需要你确认" : "没有 docker 沙箱：每条命令都需要你确认",
    };
  }

  if (input.action === "write") {
    if (input.fullAccess) {
      return { decision: "allow", reason: "已开放完整权限：允许写文件" };
    }
    // Left to the rule engine (deny/ask/allow + mode)
    return { decision: "ask", reason: "写文件需要按权限规则判定" };
  }

  return { decision: "allow", reason: "读取工作区内文件" };
}

/**
 * A minimal read-only command check: used for "without docker, subagents may only run read-only commands".
 *
 * This is not a security boundary (`python -c` can bypass it), just a **limit that reduces collateral
 * damage**: real safety comes from the main rule "no docker means subagents get no execution rights".
 */
const READ_ONLY_COMMANDS = [
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "rg",
  "ag",
  "find",
  "fd",
  "ls",
  "dir",
  "tree",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "pwd",
  "echo",
  "printf",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git blame",
  "git ls-files",
  "npm ls",
  "pip list",
  "python --version",
  "node --version",
];

/**
 * The "restricted read-only" commands that are actually allowed to run on the host when there is no Docker.
 *
 * This is not a sandbox, just a strict allow-list: commands still run with the current user's
 * privileges. It is deliberately far more conservative than `isReadOnlyCommand` -- no find/fd/sed/awk/less,
 * no options such as -exec/--pre/--output/--ext-diff that can execute or write files, and no shell
 * metacharacters.
 */
const HOST_READONLY_COMMANDS = new Set([
  "cat",
  "type",
  "head",
  "tail",
  "wc",
  "ls",
  "dir",
  "pwd",
  "rg",
  "grep",
  "npm",
  "pip",
  "python",
  "python3",
  "node",
]);

const HOST_READONLY_GIT = new Set(["status", "diff", "log", "show", "blame", "ls-files"]);

const HOST_READONLY_BANNED = new Set([
  "sed",
  "awk",
  "find",
  "fd",
  "tree",
  "less",
  "more",
  "vi",
  "vim",
  "nano",
  "bash",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
  "perl",
  "ruby",
  "php",
  "docker",
]);

export function isHostReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text || /[|;&<>`$(){}\[\]\r\n]/.test(text)) return false;
  const parts = text.split(/\s+/);
  const name = (parts[0] ?? "").toLowerCase();
  if (HOST_READONLY_BANNED.has(name)) return false;

  if (name === "git") {
    const sub = (parts[1] ?? "").toLowerCase();
    if (!HOST_READONLY_GIT.has(sub)) return false;
    return !parts.slice(2).some((arg) => {
      const lower = arg.toLowerCase();
      return (
        lower.startsWith("-c") ||
        lower.startsWith("--config-env") ||
        ["--ext-diff", "--textconv", "--output", "--exec-path", "--open-files-in-pager", "--paginate", "--no-index"].some(
          (flag) => lower === flag || lower.startsWith(`${flag}=`),
        )
      );
    });
  }

  if (!HOST_READONLY_COMMANDS.has(name)) return false;
  if (name === "rg") {
    return !parts.slice(1).some((arg) => {
      const lower = arg.toLowerCase();
      return lower === "--pre" || lower.startsWith("--pre=") || lower === "--pre-glob" || lower === "--hostname-bin" || lower === "--search-zip" || lower === "-z";
    });
  }
  if (name === "npm") return parts[1]?.toLowerCase() === "ls";
  if (name === "pip") return parts[1]?.toLowerCase() === "list";
  if (name === "python" || name === "python3" || name === "node") {
    return parts[1]?.toLowerCase() === "--version" || parts[1]?.toLowerCase() === "-v";
  }
  return true;
}

export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (!text) return false;
  // Redirections, pipes, separators and command substitution are never treated as read-only (too easy to abuse)
  if (/[|;&<>`$]/.test(text)) return false;
  return READ_ONLY_COMMANDS.some((prefix) => text === prefix || text.startsWith(`${prefix} `));
}
