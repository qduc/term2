/** Native goal-stop policy. It proposes continuation; it never drives the engine. */
import type { Item } from '../model/index.js';
import {
  directGoalCheckReceipt,
  parseDirectGoalCheck,
  type DirectGoalCheck,
  type DirectGoalState,
  type DirectGoalWrite,
} from './direct-goal.js';

/** Keep the original two idle retries / six reminders per human instruction. */
export const DIRECT_GOAL_IDLE_REMINDERS = 2;
export const DIRECT_GOAL_TURN_REMINDERS = 6;
export type DirectGoalHistoryItem = { readonly item: Item; readonly modelStep: number };
export type DirectGoalReminderFact = {
  readonly type: 'goal_stop_reminded';
  readonly turnId: string;
  /** Length of the current human-instruction window, before inserting this notice. */
  readonly afterItemCount: number;
  readonly reason: 'missing_check' | 'incomplete_check' | 'not_achieved';
};
export type DirectGoalStopInput = {
  /** Only accepted items since the latest real human input. Preserve across compaction. */
  readonly history: readonly DirectGoalHistoryItem[];
  /** Accepted reminders for the same human-instruction window. */
  readonly reminders: readonly DirectGoalReminderFact[];
  readonly turnId: string;
  readonly goalToolAvailable: boolean;
};
export type DirectGoalStopDecision =
  | { readonly action: 'stop'; readonly reason: 'no_active_goal' | 'tool_unavailable' | 'blocked' | 'deferred' }
  | { readonly action: 'verify'; readonly check: DirectGoalCheck }
  | { readonly action: 'continue'; readonly reminder: string; readonly fact: DirectGoalReminderFact }
  | {
      readonly action: 'stop';
      readonly reason: 'unresolved';
      readonly terminalCause: 'goal_check_unresolved';
      readonly notice: string;
    };

function finalCheck(
  state: DirectGoalState,
  history: readonly DirectGoalHistoryItem[],
): { check?: DirectGoalCheck; problem: string } {
  let lastCall = -1;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.item.type === 'tool_call') {
      lastCall = index;
      break;
    }
  }
  if (lastCall < 0) return { problem: 'missing_check' };
  const entry = history[lastCall]!;
  const call = entry.item;
  if (call.type !== 'tool_call' || call.toolName !== 'goal_check') return { problem: 'missing_check' };
  const calls = history.filter(({ item, modelStep }) => modelStep === entry.modelStep && item.type === 'tool_call');
  if (calls.length !== 1) return { problem: 'goal_check must be called by itself, after other results' };
  const results = history.slice(lastCall + 1).filter(({ item }) => item.type === 'tool_result');
  const result = results[0]?.item;
  if (
    results.length !== 1 ||
    result?.type !== 'tool_result' ||
    result.callId !== call.callId ||
    result.isError ||
    !result.output.startsWith(`${directGoalCheckReceipt(state)} `)
  ) {
    return { problem: 'the final goal_check has no successful recorded result for the current goal' };
  }
  try {
    return { check: parseDirectGoalCheck(call.input, state.goal), problem: '' };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A check counts only as the final lone call with its own accepted receipt.
 * Reminders are Session facts, never inferred from user-authored notice text.
 * Non-goal work resets only the idle counter; it cannot waive the total bound.
 */
export function decideDirectGoalStop(state: DirectGoalState, input: DirectGoalStopInput): DirectGoalStopDecision {
  if (!input.goalToolAvailable) return { action: 'stop', reason: 'tool_unavailable' };
  if (state.goal?.status !== 'active') return { action: 'stop', reason: 'no_active_goal' };
  const result = finalCheck(state, input.history);
  if (result.check?.status === 'achieved') return { action: 'verify', check: result.check };
  if (result.check?.status === 'blocked' || result.check?.status === 'deferred')
    return { action: 'stop', reason: result.check.status };
  const lastWork = input.history.reduce(
    (last, { item }, index) => (item.type === 'tool_call' && item.toolName !== 'goal_check' ? index : last),
    -1,
  );
  const idle = input.reminders.filter((reminder) => lastWork < reminder.afterItemCount).length;
  if (idle >= DIRECT_GOAL_IDLE_REMINDERS || input.reminders.length >= DIRECT_GOAL_TURN_REMINDERS) {
    return {
      action: 'stop',
      reason: 'unresolved',
      terminalCause: 'goal_check_unresolved',
      notice:
        'Goal stop check unresolved after repeated reminders. The durable goal remains active; control returns to the user.',
    };
  }
  const reason = result.check
    ? 'not_achieved'
    : result.problem === 'missing_check'
    ? 'missing_check'
    : 'incomplete_check';
  return {
    action: 'continue',
    fact: { type: 'goal_stop_reminded', turnId: input.turnId, afterItemCount: input.history.length, reason },
    reminder:
      `Durable goal stop check (${idle + 1} of ${DIRECT_GOAL_IDLE_REMINDERS} without new work, ` +
      `${input.reminders.length + 1} of ${DIRECT_GOAL_TURN_REMINDERS} this turn): ` +
      (result.check
        ? 'Your check reported not_achieved. Continue working now, or report blocked with the missing input or capability. '
        : `Before ending, call goal_check by itself after the latest work and results (${result.problem}). `) +
      'Achieved requires concrete outcome and criteria evidence; blocked needs the exact missing input; deferred is for newer instructions or a pause. ' +
      'The goal is context, not permission. Newer user instructions and ordinary approvals still apply.',
  };
}

export type DirectNormalStop = {
  readonly action: 'stop' | 'continue';
  readonly reminder?: string;
  readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked';
  readonly notice?: string;
  readonly goalMarkedAchieved?: boolean;
};
export type DirectGoalVerificationVerdict =
  | { readonly action: 'complete' }
  | { readonly action: 'repair'; readonly evidence: string }
  | { readonly action: 'blocked'; readonly reason: string; readonly unavailable?: boolean };

/**
 * Bind to the engine's normal-stop seam, after acceptance of all response items.
 * All commits are Session-owned compare-and-set operations, not new log writers.
 * Enabled verification without an adapter blocks completion rather than skipping it.
 */
export function createDirectGoalStopPolicy(deps: {
  readonly readGoal: () => DirectGoalState;
  readonly commitGoal: DirectGoalWrite;
  readonly commitReminder: (fact: DirectGoalReminderFact) => boolean | Promise<boolean>;
  readonly verificationEnabled: () => boolean;
  /** Match unattended CLI behavior: verifier unavailable is a visible non-completion notice, not a completed goal. */
  readonly unattended?: boolean;
  readonly verify?: (
    goal: DirectGoalState,
    check: DirectGoalCheck,
    signal: AbortSignal,
  ) => Promise<DirectGoalVerificationVerdict>;
}): (input: DirectGoalStopInput, signal: AbortSignal) => Promise<DirectNormalStop> {
  return async (input, signal) => {
    const state = deps.readGoal();
    const decision = decideDirectGoalStop(state, input);
    const blocked = (reason: string, unavailable = false): DirectNormalStop => {
      if (unavailable && deps.unattended && !signal.aborted)
        return {
          action: 'stop',
          notice: `independent verification not performed: ${reason}. The durable goal remains active.`,
        };
      return {
        action: 'stop',
        terminalCause: 'completion_verification_blocked',
        notice: `Completion verification blocked: ${reason}. The durable goal remains active.`,
      };
    };
    if (decision.action === 'stop')
      return {
        action: 'stop',
        ...('terminalCause' in decision ? { terminalCause: decision.terminalCause, notice: decision.notice } : {}),
      };
    if (signal.aborted) return blocked('Task cancelled');
    try {
      if (decision.action === 'continue') {
        if (!(await deps.commitReminder(decision.fact))) return blocked('Could not persist goal reminder');
        return { action: 'continue', reminder: decision.reminder };
      }
      if (deps.verificationEnabled()) {
        if (!deps.verify) return blocked('Independent verifier unavailable', true);
        const verdict = await deps.verify(state, decision.check, signal);
        if (signal.aborted || deps.readGoal().generation !== state.generation)
          return blocked('Goal changed or task cancelled during verification');
        if (verdict.action === 'blocked') return blocked(verdict.reason, verdict.unavailable);
        if (verdict.action === 'repair')
          return {
            action: 'continue',
            reminder:
              'Independent verification found a reproducible failure. Repair it, verify, and call goal_check again. ' +
              'Existing user permissions still apply. Reproduce against current state: ' +
              verdict.evidence,
          };
      }
      if (
        !state.goal ||
        signal.aborted ||
        !(await deps.commitGoal(state.generation, [
          { type: 'goal_changed', goal: { ...state.goal, status: 'achieved' }, source: 'goal_check' },
        ]))
      )
        return blocked('Goal changed, task cancelled, or goal persistence failed');
      return { action: 'stop', goalMarkedAchieved: true };
    } catch {
      return blocked('Verification or goal persistence failed');
    }
  };
}
