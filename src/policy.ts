/**
 * 沙箱/权限策略（纯函数）。
 *
 * 输入：工作区是否受信任、docker 是否可用、是否"开放完整权限"、是主代理还是子代理、
 *      动作（读/写/跑）、目标是否在工作区内、命令是否只读。
 * 输出：allow / ask / deny + 原因。
 *
 * 优先级（从高到低）：
 *   1. 不受信任 → 只读（工作区内）
 *   2. 工作区外 → 子代理一律拒绝；主代理一律 ask（无论有没有 docker）
 *   3. 子代理：没有 docker 时禁止写与执行（只读命令除外）；有 docker 时执行放行
 *   4. 主代理：有 docker 时执行必须走沙箱；没有 docker 时每次执行都要审批
 *   5. 开放完整权限（fullAccess）可以免掉 4 里的审批，但不免 1/2
 */

export type AgentRole = "main" | "subagent";
export type PolicyAction = "read" | "write" | "run";

export interface PolicyInput {
  trusted: boolean;
  dockerAvailable: boolean;
  /** 用户选择"开放完整权限"（只影响审批，不解除工作区外/未受信任的限制） */
  fullAccess: boolean;
  role: AgentRole;
  action: PolicyAction;
  /** 目标是否在工作区内（读写=路径，执行=cwd） */
  insideWorkspace: boolean;
  /** 仅 run 有效：这条命令是否被判定为只读（子代理在无沙箱时唯一允许的命令） */
  readOnlyCommand?: boolean;
}

export interface PolicyDecision {
  decision: "allow" | "ask" | "deny";
  reason: string;
}

export function decide(input: PolicyInput): PolicyDecision {
  // ① 未受信任：只读，且只限工作区内
  if (!input.trusted) {
    if (input.action === "read" && input.insideWorkspace) {
      return { decision: "allow", reason: "工作区未受信任：允许读取工作区内文件" };
    }
    return { decision: "deny", reason: "工作区未受信任：只读（禁止写入、执行与工作区外访问）" };
  }

  // ② 工作区外：子代理一律拒绝；主代理一律需要审批（无论有没有 docker）
  if (!input.insideWorkspace) {
    if (input.role === "subagent") {
      return { decision: "deny", reason: "子代理不允许操作工作区外的路径" };
    }
    return { decision: "ask", reason: "目标是工作区外的路径，需要你确认" };
  }

  // ③ 子代理
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

  // ④ 主代理
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
    // 交给规则引擎（deny/ask/allow + 模式）决定
    return { decision: "ask", reason: "写文件需要按权限规则判定" };
  }

  return { decision: "allow", reason: "读取工作区内文件" };
}

/**
 * 极简只读命令判定：用于"没有 docker 时，子代理只允许跑只读命令"。
 *
 * 这不是安全边界（`python -c` 可以绕过），只是一个**降低误伤**的门槛：
 * 真正的安全来自"没有 docker 就不给子代理执行权"这条主规则。
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

export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (!text) return false;
  // 有重定向、管道、连接符、命令替换时一律不当作只读（太容易被利用）
  if (/[|;&<>`$]/.test(text)) return false;
  return READ_ONLY_COMMANDS.some((prefix) => text === prefix || text.startsWith(`${prefix} `));
}
