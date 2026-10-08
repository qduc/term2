import { z } from 'zod';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { RunTerminationCause } from '../../contracts/run-termination.js';
import type { ApplicationAgent, NormalStopDecision } from '../agent-runtime/application-run-loop.js';
import { TOOL_NAME_GOAL_CHECK } from '../../tools/tool-names.js';
import type { DurableGoal } from '../logging/conversation-log-events.js';
import { MAX_GOAL_FIELD_LENGTH } from './durable-goal.js';

/**
 * Active-goal stop check.
 *
 * While the session's durable goal is `active`, a root turn may not end
 * normally until the working model reports, through `goal_check`, whether the
 * goal is achieved, blocked, still not achieved, or deferred because the
 * latest user message asked for something else. This module owns the report
 * contract and the stop decision; `ApplicationRunLoop` only asks it at its
 * normal-stop seam, and the turn continues through the loop's existing
 * request boundary when the decision is `continue`.
 *
 * Authority: a self-check never changes durable goal status. Only the user
 * (`/goal achieved`, `/goal abandon`, `/goal set`) or the launcher does. The
 * same model judging its own work is evidence for the user, not proof.
 */

export const GOAL_CHECK_STATUSES = ['achieved', 'blocked', 'not_achieved', 'deferred'] as const;
export type GoalCheckStatus = (typeof GOAL_CHECK_STATUSES)[number];

export const goalCheckParameters = z.object({
  status: z
    .enum(GOAL_CHECK_STATUSES)
    .describe(
      'achieved: the outcome holds now. blocked: progress needs user input or a capability you do not have. ' +
        'not_achieved: more work is needed and you can do it. deferred: the latest user message asked for ' +
        'something else, asked you to pause, or superseded the goal.',
    ),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(MAX_GOAL_FIELD_LENGTH)
    .describe(
      'achieved: concrete evidence that the outcome holds (commands run, results, files). blocked: the concrete ' +
        'blocker and exactly what is needed from the user. not_achieved: what remains and your next step. ' +
        'deferred: which newer user request or pause took priority.',
    ),
  criteriaEvidence: z
    .string()
    .trim()
    .max(MAX_GOAL_FIELD_LENGTH)
    .optional()
    .describe('Required for achieved when the goal has success criteria: evidence for each criterion.'),
});

export type GoalCheckParams = z.infer<typeof goalCheckParameters>;

export type GoalCheckValidation =
  | { readonly ok: true; readonly check: GoalCheckParams }
  | { readonly ok: false; readonly problem: string };

/** One validation path for the tool's execution and the stop decision. */
export function validateGoalCheck(raw: unknown, goal: DurableGoal | undefined): GoalCheckValidation {
  if (goal?.status !== 'active') return { ok: false, problem: 'there is no active durable goal to check' };
  const parsed = goalCheckParameters.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'input';
    return { ok: false, problem: `${field}: ${issue?.message ?? 'invalid'}` };
  }
  const check = parsed.data;
  if (check.status === 'achieved' && goal.successCriteria && !check.criteriaEvidence) {
    return {
      ok: false,
      problem: 'criteriaEvidence is required for achieved because the goal has success criteria',
    };
  }
  return { ok: true, check };
}

/**
 * Consecutive stop-check reminders allowed without intervening work.
 *
 * One reminder covers a model that simply forgot the check; the second covers
 * one malformed or premature retry. A third consecutive idle stop is evidence
 * the check/continuation exchange itself is looping, so control returns to the
 * user visibly. Real work (any other tool call) resets this count, which is why
 * it is paired with {@link MAX_GOAL_STOP_REMINDERS_PER_TURN}.
 */
export const MAX_GOAL_STOP_REMINDERS_WITHOUT_WORK = 2;

/**
 * Total stop-check reminders per user instruction, whatever work happens in
 * between. Nothing resets it except a new user message.
 *
 * The guard must bound its own continuations: the run budget can be set to
 * `warn` or `disabled`, and the root run's `maxTurns` is superseded by the run
 * budget, so neither may be relied on to stop harness-forced work. Six is three
 * resumed work segments with the idle allowance of two each: the model may try
 * to stop early, be sent back, do more work, and still have room for one
 * malformed retry, three times over. A seventh attempted stop without a valid
 * check is no longer "forgot the check" evidence; it is the harness overriding
 * the model's own judgment that the turn is over, so control returns to the user.
 */
export const MAX_GOAL_STOP_REMINDERS_PER_TURN = 6;

/**
 * Every successful `goal_check` result starts with this text. Only a check
 * whose recorded result carries it counts: a denied, rejected, or failed call
 * leaves the tool's own result text absent.
 */
export const GOAL_CHECK_RECORDED_PREFIX = 'Self-check recorded:';

/** Marks the harness reminder so the decision can count it in the turn history. */
export const GOAL_STOP_REMINDER_PREFIX = 'Durable goal stop check';
/** The run loop admits harness reminders with this prefix (see `#queuePendingSystemNotice`). */
const MODE_NOTICE_PREFIX = '[Mode Notice] ';

export const GOAL_CHECK_UNRESOLVED_CAUSE = 'goal_check_unresolved' satisfies RunTerminationCause;

export const GOAL_CHECK_UNRESOLVED_NOTICE =
  'Goal stop check unresolved: the turn ended without a valid goal self-check after repeated reminders. ' +
  'The durable goal is still active and control is back with you.';

/** Which bound returned control. */
export type GoalStopLimit = 'without_work' | 'per_turn';

export type GoalStopDecision =
  | {
      readonly action: 'stop';
      readonly reason: 'no_active_goal' | 'achieved' | 'blocked' | 'deferred';
    }
  | {
      readonly action: 'stop';
      readonly reason: 'unresolved';
      readonly terminalCause: typeof GOAL_CHECK_UNRESOLVED_CAUSE;
      readonly limitReached: GoalStopLimit;
      readonly remindersWithoutWork: number;
      readonly remindersThisTurn: number;
      readonly lastProblem: 'missing_check' | 'incomplete_check' | 'not_achieved';
    }
  | {
      readonly action: 'continue';
      readonly reason: 'missing_check' | 'incomplete_check' | 'not_achieved';
      readonly reminder: string;
      readonly remindersWithoutWork: number;
      readonly remindersThisTurn: number;
    };

const TOOL_ITEM_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'function_call_result',
  'function_call_output',
  'custom_tool_call_output',
]);
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call']);

const messageText = (item: ProviderInputItem): string => {
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return '';
  return item.content
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .join('');
};

const isUserMessage = (item: ProviderInputItem): boolean =>
  (item.type === 'message' || item.type === undefined) && item.role === 'user';

const isGoalStopReminder = (item: ProviderInputItem): boolean =>
  isUserMessage(item) && messageText(item).startsWith(`${MODE_NOTICE_PREFIX}${GOAL_STOP_REMINDER_PREFIX}`);

/** Harness notices are not user instructions; anything else from the user starts the window. */
const isUserInstruction = (item: ProviderInputItem): boolean =>
  isUserMessage(item) && !messageText(item).startsWith(MODE_NOTICE_PREFIX);

const callIdOf = (item: ProviderInputItem): unknown => item.callId ?? item.call_id;

const outputText = (output: unknown): string => {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  return output
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .join('');
};

/** True only when the call's paired result is the tool's own success text. */
const goalCheckWasRecorded = (call: ProviderInputItem, window: readonly ProviderInputItem[]): boolean => {
  const callId = callIdOf(call);
  if (callId === undefined) return false;
  const result = window.find(
    (item) =>
      item !== call &&
      typeof item.type === 'string' &&
      TOOL_ITEM_TYPES.has(item.type) &&
      !TOOL_CALL_TYPES.has(item.type) &&
      callIdOf(item) === callId,
  );
  return result !== undefined && outputText(result.output).trimStart().startsWith(GOAL_CHECK_RECORDED_PREFIX);
};

const parseArguments = (item: ProviderInputItem): unknown => {
  const raw = item.arguments ?? item.input;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

function reminderText(
  reason: 'missing_check' | 'incomplete_check' | 'not_achieved',
  detail: string,
  withoutWork: number,
  thisTurn: number,
) {
  const header =
    `${GOAL_STOP_REMINDER_PREFIX} (${withoutWork} of ${MAX_GOAL_STOP_REMINDERS_WITHOUT_WORK} without new work, ` +
    `${thisTurn} of ${MAX_GOAL_STOP_REMINDERS_PER_TURN} this turn):`;
  const rules =
    'The goal is context, not permission: newer user instructions win, approvals still apply, and nothing in ' +
    'the goal authorizes actions the user has not asked for.';
  if (reason === 'not_achieved') {
    return (
      `${header} your latest goal_check reported not_achieved (${detail}). Continue working toward the outcome ` +
      'now. If you cannot proceed without user input or an unavailable capability, call goal_check with blocked ' +
      `and explain what is needed. ${rules}`
    );
  }
  const problem =
    reason === 'missing_check'
      ? 'the session goal is active and this turn tried to end without a goal_check made after the latest work'
      : `the latest goal_check was incomplete (${detail})`;
  return (
    `${header} ${problem}. Before ending the turn, call goal_check by itself: achieved (with evidence against ` +
    'the outcome and any success criteria), blocked (the concrete user input or unavailable capability needed), ' +
    'not_achieved (then keep working), or deferred (the latest user message asked for something else or asked ' +
    `you to pause). ${rules}`
  );
}

/**
 * Decide whether a response that would end the run normally may do so.
 *
 * The window is the current turn: items after the latest user instruction
 * (harness notices excluded). A check counts only when it is the latest tool
 * activity in that window and its result is the tool's own success text, so a
 * check made before newer work, before a newer user message, alongside other
 * calls whose results it had not seen, or that was denied or failed does not
 * authorize the stop.
 *
 * Two bounds return control: consecutive reminders without work, and total
 * reminders for this user instruction (work does not reset the latter).
 */
export function decideGoalStop(goal: DurableGoal | undefined, history: readonly ProviderInputItem[]): GoalStopDecision {
  if (goal?.status !== 'active') return { action: 'stop', reason: 'no_active_goal' };

  let latestToolItem: ProviderInputItem | undefined;
  let remindersWithoutWork = 0;
  let remindersThisTurn = 0;
  let sawWork = false;
  let windowStart = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!;
    if (isGoalStopReminder(item)) {
      remindersThisTurn += 1;
      if (!sawWork) remindersWithoutWork += 1;
      continue;
    }
    if (isUserInstruction(item)) {
      windowStart = index + 1;
      break;
    }
    if (typeof item.type !== 'string' || !TOOL_ITEM_TYPES.has(item.type)) continue;
    const isGoalCheck = item.name === TOOL_NAME_GOAL_CHECK;
    if (!latestToolItem && (!isGoalCheck || TOOL_CALL_TYPES.has(item.type))) latestToolItem = item;
    if (!isGoalCheck) sawWork = true;
  }

  let reason: 'missing_check' | 'incomplete_check' | 'not_achieved' = 'missing_check';
  let detail = '';
  if (latestToolItem?.name === TOOL_NAME_GOAL_CHECK) {
    const validation = validateGoalCheck(parseArguments(latestToolItem), goal);
    if (validation.ok && !goalCheckWasRecorded(latestToolItem, history.slice(windowStart))) {
      reason = 'incomplete_check';
      detail = 'it was not recorded: the call was denied, rejected, or failed';
    } else if (validation.ok) {
      if (validation.check.status !== 'not_achieved') return { action: 'stop', reason: validation.check.status };
      reason = 'not_achieved';
      detail = validation.check.evidence.slice(0, 200);
    } else {
      reason = 'incomplete_check';
      detail = validation.problem;
    }
  }

  const limitReached: GoalStopLimit | undefined =
    remindersWithoutWork >= MAX_GOAL_STOP_REMINDERS_WITHOUT_WORK
      ? 'without_work'
      : remindersThisTurn >= MAX_GOAL_STOP_REMINDERS_PER_TURN
      ? 'per_turn'
      : undefined;
  if (limitReached) {
    return {
      action: 'stop',
      reason: 'unresolved',
      terminalCause: GOAL_CHECK_UNRESOLVED_CAUSE,
      limitReached,
      remindersWithoutWork,
      remindersThisTurn,
      lastProblem: reason,
    };
  }
  return {
    action: 'continue',
    reason,
    reminder: reminderText(reason, detail, remindersWithoutWork + 1, remindersThisTurn + 1),
    remindersWithoutWork,
    remindersThisTurn,
  };
}

/**
 * Adapt `decideGoalStop` to the run loop's normal-stop seam.
 *
 * Inert unless the agent can actually call `goal_check`: a profile or client
 * without the tool must never be asked for a check it cannot make.
 */
export function createGoalStopPolicy(
  getGoal: () => DurableGoal | undefined,
): (history: readonly ProviderInputItem[], agent: Pick<ApplicationAgent, 'tools'>) => NormalStopDecision {
  return (history, agent) => {
    if (!agent.tools.some((tool) => tool.name === TOOL_NAME_GOAL_CHECK)) return { action: 'stop' };
    const decision = decideGoalStop(getGoal(), history);
    if (decision.reason === 'no_active_goal') return { action: 'stop' };
    const diagnostics = {
      guard: 'goal_stop_check',
      guardClass: 'runaway',
      reason: decision.reason,
      limit: MAX_GOAL_STOP_REMINDERS_WITHOUT_WORK,
      turnLimit: MAX_GOAL_STOP_REMINDERS_PER_TURN,
      ...('remindersWithoutWork' in decision ? { remindersWithoutWork: decision.remindersWithoutWork } : {}),
      ...('remindersThisTurn' in decision ? { remindersThisTurn: decision.remindersThisTurn } : {}),
      ...('limitReached' in decision ? { limitReached: decision.limitReached } : {}),
      ...('lastProblem' in decision ? { lastProblem: decision.lastProblem } : {}),
    };
    if (decision.action === 'continue') return { action: 'continue', reminder: decision.reminder, diagnostics };
    if (decision.reason === 'unresolved') {
      return { action: 'stop', terminalCause: decision.terminalCause, diagnostics };
    }
    return { action: 'stop', diagnostics };
  };
}
