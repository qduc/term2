import type { ApprovalRecord } from '../approval/approval-replay.js';

/**
 * A tool call identified for approval decisions. Typed replacement for the
 * shape-probing (`item.toolName ?? item.rawItem?.name`) the SDK's RunContext
 * accepted.
 */
export interface ApprovalItem {
  toolName: string;
  callId: string;
}

/**
 * The approval half of the removed SDK's RunContext, as an application-owned
 * typed ledger. Semantics are pinned by `approval-replay.test.ts` and the
 * parent plan's *ApprovalRecord semantics* section — preserve them exactly:
 *
 * - the record is keyed by tool name, not call id;
 * - `approved: true` / `rejected: true` are blanket decisions covering every
 *   call of that tool;
 * - `approved: string[]` / `rejected: string[]` are per-call decisions;
 * - `false` (from `isToolApproved`) carries no decision at all — it is what a
 *   blanket decision on the other side leaves behind;
 * - a blanket approval outranks a blanket rejection (enforced by
 *   `replayApprovals` ordering, which replays rejections first).
 *
 * It does NOT carry the run's user context — that lives on
 * {@link ToolInvocationContext.context}. Splitting the two is the point: the
 * old RunContext conflated a ledger with a context bag.
 */
export class ApprovalLedger {
  #approvals: Record<string, ApprovalRecord> = {};

  approveTool(item: ApprovalItem, options: { alwaysApprove?: boolean } = {}): void {
    const current = this.#approvals[item.toolName] ?? { approved: [], rejected: [] };
    current.approved = options.alwaysApprove
      ? true
      : [...(Array.isArray(current.approved) ? current.approved : []), item.callId];
    this.#approvals[item.toolName] = current;
  }

  rejectTool(item: ApprovalItem, options: { alwaysReject?: boolean; message?: string } = {}): void {
    const current = this.#approvals[item.toolName] ?? { approved: [], rejected: [] };
    current.rejected = options.alwaysReject
      ? true
      : [...(Array.isArray(current.rejected) ? current.rejected : []), item.callId];
    if (options.message) current.messages = { ...(current.messages ?? {}), [item.callId]: options.message };
    if (options.alwaysReject && options.message) current.stickyRejectMessage = options.message;
    this.#approvals[item.toolName] = current;
  }

  isToolApproved(input: { toolName: string; callId: string }): boolean | undefined {
    const record = this.#approvals[input.toolName];
    if (!record) return undefined;
    if (record.approved === true) return true;
    if (record.rejected === true) return false;
    if (Array.isArray(record.approved) && record.approved.includes(input.callId)) return true;
    if (Array.isArray(record.rejected) && record.rejected.includes(input.callId)) return false;
    return undefined;
  }

  getRejectionMessage(toolName: string, callId: string): string | undefined {
    const record = this.#approvals[toolName];
    return record?.messages?.[callId] ?? record?.stickyRejectMessage;
  }

  /**
   * Plain copy of the ledger for parent→child replay (replaces the old
   * `toJSON()` structural probe in `readParentApprovals`). Same record shape
   * `replayApprovals` consumes, so a snapshot replays into a fresh ledger.
   */
  snapshot(): Readonly<Record<string, ApprovalRecord>> {
    return structuredClone(this.#approvals);
  }
}

/**
 * Per-run tool invocation context handed to `execute` / `invoke` /
 * `needsApproval` by the application run loop. Replaces the raw options object
 * the loop used to pass (which is why subagent bookkeeping — F2 — and parent
 * approval replay — F5 — were both dead).
 */
export interface ToolInvocationContext<T = unknown> {
  /** The run's user context (e.g. SubagentRunContext), from run options. */
  readonly context: T;
  /** This run's approval ledger; decisions made in this run accumulate here. */
  readonly approvals: ApprovalLedger;
  readonly signal?: AbortSignal;
}
