/**
 * 权限规则引擎（纯函数，不依赖 vscode，便于单测）。
 *
 * 三层判定，顺序固定：**deny → ask → allow → 模式默认**。
 * deny 永远优先，allow 不能从 deny 里"挖例外"——顺序反了就是安全问题。
 *
 * 规则语法（对齐 Claude Code 的习惯，降低学习成本）：
 *   Read(src/**)        按路径 glob
 *   Edit(src/**)        写（含删除）
 *   Run(npm test *)     命令前缀（`*` 结尾表示前缀匹配）
 *   Run(git push)       精确匹配
 *
 * 匹配用的工具名大小写不敏感；`Shell` 与 `Run` 等价，`Write` 与 `Edit` 等价。
 */

export type PermissionMode = "plan" | "manual" | "acceptEdits" | "auto" | "bypass";
export type Action = "read" | "write" | "run";
export type Decision = "allow" | "ask" | "deny";
/** 决定来自哪里：显式规则 / 模式默认 / 工作区信任 */
export type DecisionSource = "rule" | "mode" | "trust";

export interface Rule {
  raw: string;
  action: Action;
  /** 路径 glob 或命令模式；省略表示该动作的全部 */
  pattern?: string;
  decision: Decision;
}

export interface Evaluation {
  decision: Decision;
  source: DecisionSource;
  /** 人类可读的原因，会显示在确认框与日志里 */
  reason: string;
  /** 命中的规则原文（用于 confirm 的"记住"键、日志） */
  rule?: string;
}

const MODE_DEFAULTS: Record<PermissionMode, Record<Action, Decision>> = {
  // plan：只读探索，不写不跑
  plan: { read: "allow", write: "deny", run: "deny" },
  // manual：写和跑都要问
  manual: { read: "allow", write: "ask", run: "ask" },
  // acceptEdits：自动接受提案（写），命令仍要问
  acceptEdits: { read: "allow", write: "allow", run: "ask" },
  // auto：低风险自动；目前写=allow，命令仍 ask（没有可靠的低风险判定）
  auto: { read: "allow", write: "allow", run: "ask" },
  // bypass：全放行（只应在容器/VM 里用）
  bypass: { read: "allow", write: "allow", run: "allow" },
};

/** 写这些路径时，即使模式允许也要额外确认（可被显式 allow 规则覆盖） */
const SENSITIVE_WRITE_GLOBS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/.npmrc",
  "**/.netrc",
  ".git/**",
  "**/.git/**",
  ".github/workflows/**",
];

const TOOL_ALIASES: Record<string, Action> = {
  read: "read",
  edit: "write",
  write: "write",
  delete: "write",
  run: "run",
  shell: "run",
  bash: "run",
};

export function parseRule(raw: string, decision: Decision): Rule | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  const match = /^([a-zA-Z]+)\s*(?:\((.*)\))?$/.exec(text);
  if (!match) return undefined;

  const tool = (match[1] ?? "").toLowerCase();
  const action = TOOL_ALIASES[tool];
  if (!action) return undefined;

  const pattern = (match[2] ?? "").trim();
  return { raw: text, action, pattern: pattern.length > 0 ? pattern : undefined, decision };
}

export interface RuleSet {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
}

export function buildRuleSet(input: {
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
}): RuleSet {
  const parseAll = (list: readonly string[] | undefined, decision: Decision): Rule[] =>
    (list ?? []).map((raw) => parseRule(raw, decision)).filter((r): r is Rule => r !== undefined);
  return {
    allow: parseAll(input.allow, "allow"),
    ask: parseAll(input.ask, "ask"),
    deny: parseAll(input.deny, "deny"),
  };
}

export interface PermissionInput {
  mode: PermissionMode;
  rules: RuleSet;
  action: Action;
  /** 写/读：工作区相对路径；运行：完整命令行 */
  target: string;
  /** 工作区是否可信；false 时写与运行一律拒绝 */
  trusted: boolean;
}

export function evaluate(input: PermissionInput): Evaluation {
  // ① 不信任的工作区：无论规则怎么写，都不允许写和执行
  if (!input.trusted && (input.action === "write" || input.action === "run")) {
    return {
      decision: "deny",
      source: "trust",
      reason: "当前工作区未受信任：只允许读取。可在命令面板运行「Bee Code: 信任此工作区」",
    };
  }

  // ② deny → ask → allow
  for (const rule of input.rules.deny) {
    if (matches(rule, input.action, input.target)) {
      return { decision: "deny", source: "rule", reason: `被规则拒绝：${rule.raw}`, rule: rule.raw };
    }
  }
  for (const rule of input.rules.ask) {
    if (matches(rule, input.action, input.target)) {
      return { decision: "ask", source: "rule", reason: `规则要求确认：${rule.raw}`, rule: rule.raw };
    }
  }
  for (const rule of input.rules.allow) {
    if (matches(rule, input.action, input.target)) {
      return { decision: "allow", source: "rule", reason: `被规则允许：${rule.raw}`, rule: rule.raw };
    }
  }

  // ③ 模式默认
  const decision = MODE_DEFAULTS[input.mode][input.action];
  return {
    decision,
    source: "mode",
    reason:
      decision === "deny"
        ? `当前模式（${input.mode}）不允许该操作`
        : decision === "ask"
          ? `当前模式（${input.mode}）要求确认`
          : `当前模式（${input.mode}）允许该操作`,
  };
}

/** 写敏感路径时是否值得再问一次（模式放行 ≠ 用户知情） */
export function isSensitiveWrite(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return SENSITIVE_WRITE_GLOBS.some((glob) => globToRegExp(glob).test(normalized));
}

export function effectiveMode(mode: string | undefined): PermissionMode {
  const value = (mode ?? "").trim();
  if (value === "plan" || value === "manual" || value === "acceptEdits" || value === "auto" || value === "bypass") {
    return value;
  }
  return "manual";
}

// ───────────────────────── 内部 ─────────────────────────

function matches(rule: Rule, action: Action, target: string): boolean {
  if (rule.action !== action) return false;
  if (rule.pattern === undefined) return true;

  // 运行：命令模式
  if (action === "run") return matchCommand(rule.pattern, target);
  // 读写：路径 glob（同时容忍绝对路径——调用方传入前应已转相对）
  return globToRegExp(rule.pattern).test(target.replace(/\\/g, "/"));
}

/**
 * 命令匹配：
 *   `npm test *`  → 前缀匹配（"npm test" 或 "npm test --watch" 都算）
 *   `git push`    → 精确匹配整条命令
 *   `curl *`      → 前缀
 */
export function matchCommand(pattern: string, command: string): boolean {
  const patternText = pattern.trim();
  const commandText = command.trim();
  if (patternText === "*") return true;

  if (patternText.endsWith("*")) {
    const prefix = patternText.slice(0, -1).trimEnd();
    return commandText === prefix || commandText.startsWith(`${prefix} `);
  }
  return commandText === patternText;
}

/**
 * 把 glob 转成正则。
 *
 * 只支持三种通配（够用且可预测）：
 *   `**` → 任意层级（含空）
 *   `*`  → 单层内任意字符
 *   `?`  → 单个字符
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` 可以匹配零层目录
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeRegExp(ch ?? "");
  }
  out += "$";
  return new RegExp(out);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
