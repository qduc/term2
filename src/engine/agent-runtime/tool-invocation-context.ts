import type { RunBudgetEvent, RunBudgetEvidence, RunBudgetPolicy } from './run-budget.js';
import type { NestedApprovalLedger } from '../../tools/nested-run-driver.js';

export interface ToolInvocationContext<T = unknown> {
  /** The run's user context (e.g. SubagentRunContext), from run options. */
  readonly context: T;
  /** This run's approval ledger; decisions made in this run accumulate here. */
  readonly approvals: NestedApprovalLedger;
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
  takeStallEvidence():
    | Extract<
        RunBudgetEvent,
        {
          type: 'tool_stall';
        }
      >
    | undefined;
  /** What this run has left, so a child it launches can be clamped to it. */
  remainingPolicy(): RunBudgetPolicy | undefined;
}
