import type { ApprovalRecord } from '../approval/approval-replay.js';
import type { RunBudgetEvent, RunBudgetEvidence, RunBudgetPolicy } from './run-budget.js';

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
 * typed ledger:
 *
 * - the record is keyed by tool name, not call id;
 * - `approved: true` / `rejected: true` are blanket decisions covering every
 *   call of that tool;
 * - `approved: string[]` / `rejected: string[]` record which calls a one-time
 *   decision was made for;
 * - a blanket approval outranks a blanket rejection ({@link ApprovalLedger.blanketDecision}).
 *
 * Only blanket decisions are ever consulted ({@link ApprovalLedger.blanketDecision}).
 * A one-time decision belongs to the plan entry it settled — its rejection
 * message becomes that entry's output — and the per-call entries here are a
 * record only: call ids repeat across responses and runs, so they can never
 * authorize, reject, or explain a later call.
 *
 * It does NOT carry the run's user context — that lives on
 * {@link ToolInvocationContext.context}. Splitting the two is the point: the
 * old RunContext conflated a ledger with a context bag.
 */
export class ApprovalLedger {
  #approvals: Record<string, ApprovalRecord> = {};

  approveTool(item: ApprovalItem, options: { alwaysApprove?: boolean } = {}): void {
    const current = this.#approvals[item.toolName] ?? { approved: [], rejected: [] };
    // Recording a one-time decision must not erase a blanket one for the tool.
    current.approved =
      options.alwaysApprove || current.approved === true
        ? true
        : [...(Array.isArray(current.approved) ? current.approved : []), item.callId];
    this.#approvals[item.toolName] = current;
  }

  /**
   * `message` is kept only for a blanket rejection, where it explains every
   * later call. A one-time rejection's message is the settled plan entry's
   * output, not ledger state.
   */
  rejectTool(item: ApprovalItem, options: { alwaysReject?: boolean; message?: string } = {}): void {
    const current = this.#approvals[item.toolName] ?? { approved: [], rejected: [] };
    // Recording a one-time decision must not erase a blanket one for the tool.
    current.rejected =
      options.alwaysReject || current.rejected === true
        ? true
        : [...(Array.isArray(current.rejected) ? current.rejected : []), item.callId];
    if (options.alwaysReject && options.message) current.stickyRejectMessage = options.message;
    this.#approvals[item.toolName] = current;
  }

  /**
   * The tool's blanket decision, ignoring per-call entries. Call ids are not
   * unique across responses (the chat adapter's `call_${index}` fallback, or a
   * provider that repeats its own ids), so a per-call entry cannot identify a
   * new call: it only records the call it was made for.
   */
  blanketDecision(toolName: string): boolean | undefined {
    const record = this.#approvals[toolName];
    if (record?.approved === true) return true;
    if (record?.rejected === true) return false;
    return undefined;
  }

  /** The message a blanket rejection of the tool gives every call it rejects. */
  blanketRejectionMessage(toolName: string): string | undefined {
    const record = this.#approvals[toolName];
    return record?.rejected === true ? record.stickyRejectMessage : undefined;
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
  /**
   * The run's turn budget, owned and counted by the loop. `count` is the turn
   * currently executing (1-based); `max` is undefined for an unbounded run.
   * Tools read this to warn the model as the budget runs out.
   */
  readonly turn?: TurnBudget;
  /** Per-run staged budget. A soft nudge is consumed by the nearest tool result. */
  readonly budget?: RunBudgetToolContext;
  /**
   * Set when the call comes from inside a `run_code` script rather than from
   * the model directly.
   *
   * The distinction that matters is who receives the result. A direct call's
   * result enters model context and is capped to protect it; a scripted
   * call's result goes to the script, which usually reduces it, and only the
   * script's return value reaches context (capped separately by
   * `maxOutputBytes`). Applying the context cap to a scripted read hands the
   * script a partial file and a header that still claims the full length.
   */
  readonly scripted?: boolean;
}

export interface TurnBudget {
  readonly count: number;
  readonly max?: number;
}

export interface RunBudgetToolContext {
  takeSoftEvidence(): RunBudgetEvidence | undefined;
  /** A repetition notice for the run that issued it, re-armed on every recurrence. */
  takeStallEvidence(): Extract<RunBudgetEvent, { type: 'tool_stall' }> | undefined;
  /** What this run has left, so a child it launches can be clamped to it. */
  remainingPolicy(): RunBudgetPolicy | undefined;
}
