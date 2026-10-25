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
      return { decision: "allow", reason: "Untrusted workspace: reading files inside the workspace is allowed" };
    }
    return { decision: "deny", reason: "Untrusted workspace: read-only (no writes, execution, or access outside the workspace)" };
  }

  // ② Outside the workspace: always deny for subagents; always require approval for the main agent (docker or not)
  if (!input.insideWorkspace) {
    if (input.role === "subagent") {
      return { decision: "deny", reason: "Subagents may not access paths outside the workspace" };
    }
    return { decision: "ask", reason: "The target is outside the workspace and requires your confirmation" };
  }

  // ③ Subagent
  if (input.role === "subagent") {
    if (input.action === "write") {
      if (!input.dockerAvailable) {
        return { decision: "deny", reason: "Without a Docker sandbox, subagents may not write files" };
      }
      return input.fullAccess
        ? { decision: "allow", reason: "Full access granted: subagents may write" }
        : { decision: "ask", reason: "A subagent wants to write files and requires your confirmation" };
    }
    if (input.action === "run") {
      if (input.dockerAvailable) {
        return { decision: "allow", reason: "Subagent commands will run inside the Docker sandbox" };
      }
      if (input.readOnlyCommand) {
        return { decision: "allow", reason: "Without Docker, subagents may only run read-only commands" };
      }
      return { decision: "deny", reason: "Without a Docker sandbox, subagents may not run commands that modify the system" };
    }
    return { decision: "allow", reason: "Subagent is reading workspace files" };
  }

  // ④ Main agent
  if (input.action === "run") {
    if (input.fullAccess) {
      return {
        decision: "allow",
        reason: input.dockerAvailable ? "Full access granted: commands run inside the Docker sandbox" : "Full access granted: commands run directly",
      };
    }
    return {
      decision: "ask",
      reason: input.dockerAvailable ? "Commands will run inside the Docker sandbox and require your confirmation" : "No Docker sandbox: every command requires your confirmation",
    };
  }

  if (input.action === "write") {
    if (input.fullAccess) {
      return { decision: "allow", reason: "Full access granted: file writes are allowed" };
    }
    // Left to the rule engine (deny/ask/allow + mode)
    return { decision: "ask", reason: "File writes are evaluated against permission rules" };
  }

  return { decision: "allow", reason: "Reading files inside the workspace" };
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
