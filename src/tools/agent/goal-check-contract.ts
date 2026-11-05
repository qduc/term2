import { z } from 'zod';
import { MAX_GOAL_FIELD_LENGTH, type DurableGoal } from '../../shared/contracts/durable-goal.js';

/** The self-check wire contract, consumed by both the tool and the session stop policy. */
export const GOAL_CHECK_STATUSES = ['achieved', 'blocked', 'not_achieved', 'deferred'] as const;
export type GoalCheckStatus = (typeof GOAL_CHECK_STATUSES)[number];

export const goalCheckParameters = z.object({
  status: z
    .enum(GOAL_CHECK_STATUSES)
    .describe(
      'achieved: the outcome holds now, verified against concrete evidence; this proposes completion to the harness. blocked: progress needs user input or a capability you do not have. ' +
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

/** One validation path for execution and the session's interpretation of a recorded check. */
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
    return { ok: false, problem: 'criteriaEvidence is required for achieved because the goal has success criteria' };
  }
  return { ok: true, check };
}

/** Only this successful result prefix carries a recorded goal identity to the stop policy. */
export const GOAL_CHECK_RECORDED_PREFIX = 'Self-check recorded:';

/** Serialize the identity actually judged, rather than the goal current at stop time. */
export function formatRecordedGoalCheck(goalId: string, text: string): string {
  return `${GOAL_CHECK_RECORDED_PREFIX} [goal ${goalId}] ${text}`;
}
