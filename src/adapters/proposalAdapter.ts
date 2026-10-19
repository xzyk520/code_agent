import * as vscode from "vscode";
import type { InboundRequestContext } from "../coreApi";
import type { Logger } from "../log";
import type { EditApplyResult, ProposalDto } from "../protocol";
import type { DiffAdapter } from "./diffAdapter";
import type { createEditAdapter } from "./editAdapter";

type EditAdapter = ReturnType<typeof createEditAdapter>;

/** 正文缓存有效期：超过它重新拉，避免用过期内容写盘 */
const TEXT_CACHE_TTL_MS = 30_000;

/**
 * 提案（虚拟文件）的暂存与落实。
 *
 * 模型（README §10）：
 *   1. 内核给出「修正后的完整文件内容」，但**不碰磁盘**，只发一条 `proposal.changed` 元数据
 *   2. 用户点「查看」→ 壳调 `proposal.read` 拉正文 → 左侧真实文件 / 右侧虚拟文件，`vscode.diff` 展示
 *   3. 用户点「接受」→ 壳用 `edit.apply` 一次性写入 → 成功后通知内核 `proposal.decide(accept)`
 *   4. 用户点「拒绝」→ 什么都不写，直接通知内核 `proposal.decide(reject)`
 *
 * 关键在于顺序：**先落盘、再告知内核**。反过来会出现「内核以为已应用、磁盘其实没变」。
 */
export class ProposalAdapter implements vscode.Disposable {
  private readonly byId = new Map<string, ProposalDto>();
  /** 查看过的正文短暂缓存：避免「查看 → 接受」把同一份大文件拉两次 */
  private readonly textCache = new Map<string, { text: string; at: number }>();
  private disposed = false;

  constructor(
    private readonly diff: DiffAdapter,
    private readonly edit: EditAdapter,
    private readonly logger: Logger,
  ) {}

  /**
   * 登记/更新提案。
   *
   * **同路径去重**：同一个文件只应有一个有效提案。新提案到来时，把该路径下
   * 其它仍为 pending 的旧提案标成 stale —— 否则用户可能先接受旧的那个，
   * 用旧内容覆盖掉新内容。
   */
  upsert(dto: ProposalDto): void {
    for (const [id, existing] of this.byId) {
      if (id !== dto.id && existing.path === dto.path && existing.status === "pending") {
        this.byId.set(id, {
          ...existing,
          status: "stale",
          summary: existing.summary ?? "已被同一文件的新提案取代",
        });
        this.logger.debug(`proposal ${id} 被同路径的新提案 ${dto.id} 取代（标 stale）`);
      }
    }
    this.byId.set(dto.id, dto);
  }

  remove(id: string): void {
    this.byId.delete(id);
  }

  get(id: string): ProposalDto | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.byId.clear();
    this.textCache.clear();
  }

  /** 文件在提案生成后被改过 → 标记 stale，UI 上会提示"重新生成" */
  markStale(id: string): void {
    const dto = this.byId.get(id);
    if (dto) this.byId.set(id, { ...dto, status: "stale" });
  }

  /** 面板要展示的全部提案：pending + stale（stale 也要看得见，否则会「凭空消失」） */
  visible(): ProposalDto[] {
    return [...this.byId.values()]
      .filter((p) => p.status === "pending" || p.status === "stale")
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 真正待决策的提案（stale 不算，它只能重新生成） */
  pending(): ProposalDto[] {
    return this.visible().filter((p) => p.status === "pending");
  }

  count(): number {
    return this.pending().length;
  }

  /** 打开提案 diff（左=磁盘现状，右=提案内容）。正文按需拉取，不在内存里常驻。 */
  async show(id: string, fetchText: (id: string) => Promise<string>): Promise<boolean> {
    const dto = this.byId.get(id);
    if (!dto) return false;
    let text: string;
    try {
      text = await fetchText(id);
    } catch (err) {
      this.logger.warn(`读取提案正文失败 ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.textCache.set(id, { text, at: Date.now() });
    const result = await this.diff.openProposal({ path: dto.path, text, title: dto.summary });
    return result.opened;
  }

  /**
   * 接受一个提案：拉正文 → 写盘 → 成功才通知内核。
   *
   * 失败（版本冲突 / 被锁定 / 路径被拒）时不改状态，提案继续留着，
   * 用户可以重新看一眼再决定 —— 绝不出现"内核认为已接受、文件没变"。
   */
  async accept(
    id: string,
    fetchText: (id: string) => Promise<string>,
    decide: (id: string, decision: "accept" | "reject") => Promise<void>,
  ): Promise<EditApplyResult> {
    const dto = this.byId.get(id);
    if (!dto) return { applied: false, message: "提案不存在（可能已被内核撤回）" };

    if (dto.baseVersion === undefined) {
      // 没有 baseVersion 就没法做冲突检测 —— 记一条 warn，别让它静默变成"无条件覆盖"
      this.logger.warn(`提案 ${id} 缺少 baseVersion，接受时将不做版本冲突检测（可能覆盖用户的新修改）`);
    }

    let text: string;
    const cached = this.textCache.get(id);
    if (cached && Date.now() - cached.at < TEXT_CACHE_TTL_MS) {
      text = cached.text;
    } else {
      try {
        text = await fetchText(id);
      } catch (err) {
        return { applied: false, message: `读取提案正文失败：${err instanceof Error ? err.message : String(err)}` };
      }
    }

    const result = await this.edit.apply(
      {
        path: dto.path,
        newText: text,
        expectedVersion: dto.baseVersion,
        reason: dto.summary,
      },
      syntheticContext(),
    );

    if (!result.applied) return result;

    this.byId.delete(id);
    await decide(id, "accept").catch((err: unknown) => {
      this.logger.warn(`proposal.decide(accept) 失败 ${id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return result;
  }

  /** 拒绝：磁盘一字不动，只通知内核丢掉提案 */
  async reject(
    id: string,
    decide: (id: string, decision: "accept" | "reject") => Promise<void>,
  ): Promise<void> {
    if (!this.byId.has(id)) return;
    this.byId.delete(id);
    await decide(id, "reject").catch((err: unknown) => {
      this.logger.warn(`proposal.decide(reject) 失败 ${id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.byId.clear();
    this.textCache.clear();
  }
}

/** 适配器要的 ctx 只在 RPC 场景存在；本地触发时给一个空的（无取消语义） */
function syntheticContext(): InboundRequestContext {
  return {
    id: "local",
    signal: new AbortController().signal,
    throwIfCancelled() {
      /* 本地动作不可取消 */
    },
  };
}
