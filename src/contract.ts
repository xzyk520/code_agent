import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_VERSION, type ShellMethod } from "./protocol";

/**
 * Runtime validation of the protocol contract (closing the gap that "protocol types have no single source of truth").
 *
 * Why it is needed: the interfaces in `protocol.ts` are **types**, which disappear after compilation and
 * cannot be enumerated at runtime; the Python side, meanwhile, cannot see TypeScript at all. So the
 * method/param names on both sides can only be kept in sync by hand.
 *
 * Compromise: extract the contract into `protocol/contract.json` (the single source of truth) and have
 * both sides validate it at startup:
 *   - shell: which methods are registered vs which the contract declares (flag both extras and gaps)
 *   - kernel: validates the method name and required params before every RPC (see `beecode/contract.py`)
 *
 * It cannot replace compile-time types, but it **catches drift within 100ms of startup** instead of
 * blowing up only when some branch happens to run.
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

/** Try these locations in order: extension directory (installed) -> workspace (development) -> process cwd */
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
        problems: [`Unable to parse ${candidate}: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  problems.push(`Protocol contract not found at ${CONTRACT_RELATIVE} (searched: ${roots.filter(Boolean).join(", ") || "no workspace"})`);
  return { contract: undefined, problems };
}

/** Reconcile the contract content against the runtime registry */
export function verifyRegistration(contract: ContractFile, registered: readonly ShellMethod[]): string[] {
  const problems: string[] = [];

  if (contract.version !== PROTOCOL_VERSION) {
    problems.push(`Contract version ${contract.version} does not match PROTOCOL_VERSION ${PROTOCOL_VERSION}`);
  }

  const declared = new Set(Object.keys(contract.shellMethods));
  const actual = new Set<string>(registered);

  for (const method of actual) {
    if (!declared.has(method)) problems.push(`Registered but not declared in the contract: ${method}`);
  }
  for (const method of declared) {
    if (!actual.has(method)) problems.push(`Declared in the contract but not registered: ${method}`);
  }

  return problems;
}

function checkStructure(contract: ContractFile): string[] {
  const problems: string[] = [];
  if (typeof contract.version !== "number") problems.push("version must be a number");
  if (!contract.shellMethods || typeof contract.shellMethods !== "object") problems.push("missing shellMethods");
  if (!Array.isArray(contract.coreMethods)) problems.push("missing coreMethods array");
  if (!Array.isArray(contract.notifications)) problems.push("missing notifications array");
  for (const [method, spec] of Object.entries(contract.shellMethods ?? {})) {
    if (!Array.isArray(spec.result)) problems.push(`${method} is missing the result list`);
  }
  return problems;
}
