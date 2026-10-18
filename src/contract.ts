import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_VERSION, type ShellMethod } from "./protocol";

/**
 * 协议契约的运行时校验（补齐「协议类型没有唯一真相」这个缺口）。
 *
 * 为什么需要：`protocol.ts` 的接口是**类型**，编译后消失，无法在运行时枚举；
 * 而 Python 侧又完全看不到 TypeScript。于是两侧的「方法名/参数名」只能靠人肉同步。
 *
 * 折中方案：把契约抽成 `protocol/contract.json`（唯一真相），两侧各自在启动时校验：
 *   - 壳：注册了哪些方法 vs 契约声明了哪些方法（多一个、少一个都报警）
 *   - 内核：每次发 RPC 前校验方法名与必填参数（见 `beecode/contract.py`）
 *
 * 它不能替代编译期类型，但能**在启动 100ms 内**发现两侧漂移，而不是等到运行到某个分支才炸。
 */
export interface ShellMethodSpec {
  required?: string[];
  optional?: string[];
  result?: string[];
}

export interface ContractFile {
  version: number;
  shellMethods: Record<string, ShellMethodSpec>;
  coreMethods: string[];
  notifications: string[];
}

export interface ContractCheck {
  contract: ContractFile | undefined;
  problems: string[];
}

/** 依次尝试这些位置：扩展目录（安装后）→ 工作区（开发时）→ 进程 cwd */
const CONTRACT_RELATIVE = path.join("protocol", "contract.json");

export function loadContract(roots: Array<string | undefined>): ContractCheck {
  const problems: string[] = [];

  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, CONTRACT_RELATIVE);
    if (!fs.existsSync(candidate)) continue;

    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as ContractFile;
      const structural = checkStructure(parsed);
      if (structural.length > 0) {
        return { contract: undefined, problems: structural.map((p) => `${candidate}: ${p}`) };
      }
      return { contract: parsed, problems: [] };
    } catch (err) {
      return {
        contract: undefined,
        problems: [`无法解析 ${candidate}: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  problems.push(`找不到协议契约 ${CONTRACT_RELATIVE}（已查找：${roots.filter(Boolean).join(", ") || "无工作区"}）`);
  return { contract: undefined, problems };
}

/** 契约内容与运行时注册表对账 */
export function verifyRegistration(contract: ContractFile, registered: readonly ShellMethod[]): string[] {
  const problems: string[] = [];

  if (contract.version !== PROTOCOL_VERSION) {
    problems.push(`契约版本 ${contract.version} 与 PROTOCOL_VERSION ${PROTOCOL_VERSION} 不一致`);
  }

  const declared = new Set(Object.keys(contract.shellMethods));
  const actual = new Set<string>(registered);

  for (const method of actual) {
    if (!declared.has(method)) problems.push(`已注册但契约未声明：${method}`);
  }
  for (const method of declared) {
    if (!actual.has(method)) problems.push(`契约已声明但未注册：${method}`);
  }

  return problems;
}

function checkStructure(contract: ContractFile): string[] {
  const problems: string[] = [];
  if (typeof contract.version !== "number") problems.push("version 必须是数字");
  if (!contract.shellMethods || typeof contract.shellMethods !== "object") problems.push("缺少 shellMethods");
  if (!Array.isArray(contract.coreMethods)) problems.push("缺少 coreMethods 数组");
  if (!Array.isArray(contract.notifications)) problems.push("缺少 notifications 数组");
  for (const [method, spec] of Object.entries(contract.shellMethods ?? {})) {
    if (!Array.isArray(spec.result)) problems.push(`${method} 缺少 result 列表`);
  }
  return problems;
}
