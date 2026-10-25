/**
 * Permission rule engine (pure functions, no vscode dependency, easy to unit test).
 *
 * Three-stage evaluation, with a fixed order: **deny -> ask -> allow -> mode default**.
 * deny always wins, and allow cannot "carve out an exception" from deny -- reversing the order would
 * be a security bug.
 *
 * Rule syntax (following Claude Code conventions to lower the learning curve):
 *   Read(src/**)        path glob
 *   Edit(src/**)        write (including delete)
 *   Run(npm test *)     command prefix (a trailing `*` means prefix match)
 *   Run(git push)       exact match
 *
 * Tool names are case-insensitive when matching; `Shell` is equivalent to `Run` and `Write` to `Edit`.
 */

export type PermissionMode = "plan" | "manual" | "acceptEdits" | "auto" | "bypass";
export type Action = "read" | "write" | "run";
export type Decision = "allow" | "ask" | "deny";
/** Where the decision comes from: explicit rule / mode default / workspace trust */
export type DecisionSource = "rule" | "mode" | "trust";

export interface Rule {
  raw: string;
  action: Action;
  /** Path glob or command pattern; omitted means all targets of that action */
  pattern?: string;
  decision: Decision;
}

export interface Evaluation {
  decision: Decision;
  source: DecisionSource;
  /** Human-readable reason, shown in the confirmation prompt and in logs */
  reason: string;
  /** Raw text of the matched rule (used for confirm's "remember" key and for logs) */
  rule?: string;
}

const MODE_DEFAULTS: Record<PermissionMode, Record<Action, Decision>> = {
  // plan: read-only exploration, no writes and no runs
  plan: { read: "allow", write: "deny", run: "deny" },
  // manual: both writes and runs require asking
  manual: { read: "allow", write: "ask", run: "ask" },
  // acceptEdits: proposals (writes) are accepted automatically, commands still require asking
  acceptEdits: { read: "allow", write: "allow", run: "ask" },
  // auto: low-risk actions are automatic; writes = allow for now, commands still ask (no reliable low-risk heuristic)
  auto: { read: "allow", write: "allow", run: "ask" },
  // bypass: everything is allowed (should only be used inside a container/VM)
  bypass: { read: "allow", write: "allow", run: "allow" },
};

/** Writing these paths requires an extra confirmation even when the mode allows it (an explicit allow rule can override) */
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
  /** Write/read: workspace-relative path; run: full command line */
  target: string;
  /** Whether the workspace is trusted; when false, writes and runs are always denied */
  trusted: boolean;
}

export function evaluate(input: PermissionInput): Evaluation {
  // ① Untrusted workspace: no writes and no execution no matter what the rules say
  if (!input.trusted && (input.action === "write" || input.action === "run")) {
    return {
      decision: "deny",
      source: "trust",
      reason: "当前工作区未受信任：只允许读取。可在命令面板运行「Bee Code: 信任此工作区」",
    };
  }

  // ② deny -> ask -> allow
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

  // ③ Mode defaults
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

/** Whether a write to a sensitive path deserves another question (mode allow != user informed) */
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

// ───────────────────────── internals ─────────────────────────

function matches(rule: Rule, action: Action, target: string): boolean {
  if (rule.action !== action) return false;
  if (rule.pattern === undefined) return true;

  // run: command pattern
  if (action === "run") return matchCommand(rule.pattern, target);
  // read/write: path glob (absolute paths are tolerated too -- callers should convert to relative before passing in)
  return globToRegExp(rule.pattern).test(target.replace(/\\/g, "/"));
}

/**
 * Command matching:
 *   `npm test *`  -> prefix match ("npm test" and "npm test --watch" both match)
 *   `git push`    -> exact match of the whole command
 *   `curl *`      -> prefix
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
 * Convert a glob to a regular expression.
 *
 * Only three wildcards are supported (sufficient and predictable):
 *   `**` -> any number of levels (including none)
 *   `*`  -> any characters within a single level
 *   `?`  -> a single character
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` can match zero directory levels
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
