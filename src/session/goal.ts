/** Root goal data and tools. Session supplies all state and accepts every write. */
import { z } from 'zod';
import { createDurableGoal, MAX_GOAL_FIELD_LENGTH } from './conversation/durable-goal.js';
import { GOAL_CHANGED_PROBLEM, GOAL_CHECK_DESCRIPTION } from '../tools/agent/goal-check.js';
import { goalCheckParameters } from './conversation/durable-goal-stop-check.js';
import { renderDurableGoalContext } from './prompts/durable-goal-context.js';
import type { DurableGoal } from './logging/conversation-log-events.js';
import type { Tool } from '../tools/index.js';

export { createDurableGoal, renderDurableGoalContext, MAX_GOAL_FIELD_LENGTH };
export type { DurableGoal };

export type DirectGoalState = {
  /** Increment on every goal change, including clearing and reopening the same id. */
  readonly generation: number;
  readonly goal?: DurableGoal;
  readonly proposalMade: boolean;
};
export type DirectGoalFact =
  | {
      readonly type: 'goal_changed';
      readonly goal?: DurableGoal;
      readonly source: 'user' | 'launcher' | 'proposal' | 'goal_check';
    }
  | { readonly type: 'goal_proposed'; readonly goal: DurableGoal };
export type DirectGoalWrite = (
  expectedGeneration: number,
  facts: readonly DirectGoalFact[],
) => boolean | Promise<boolean>;

// Keep the model-facing contract (including field guidance) identical to source.
export const directGoalCheckSchema = goalCheckParameters;
export type DirectGoalCheck = z.infer<typeof directGoalCheckSchema>;
export const DIRECT_GOAL_CHECK_PREFIX = 'Self-check recorded:';

/** Pure replay projection; invoke only after Session has accepted a goal fact. */
export function reduceDirectGoal(state: DirectGoalState, fact: DirectGoalFact): DirectGoalState {
  if (fact.type === 'goal_proposed') {
    if (state.goal || state.proposalMade) throw new Error('A goal exists or a proposal was already made');
    return { ...state, proposalMade: true };
  }
  if (
    fact.source === 'goal_check' &&
    (state.goal?.status !== 'active' ||
      fact.goal?.status !== 'achieved' ||
      fact.goal.id !== state.goal.id ||
      fact.goal.outcome !== state.goal.outcome ||
      fact.goal.successCriteria !== state.goal.successCriteria)
  ) {
    throw new Error('A self-check can only achieve the unchanged active goal');
  }
  return {
    generation: state.generation + 1,
    ...(fact.goal ? { goal: fact.goal } : {}),
    proposalMade: state.proposalMade,
  };
}

/** One validation contract for execution and the native normal-stop policy. */
export function parseDirectGoalCheck(raw: unknown, goal?: DurableGoal): DirectGoalCheck {
  if (goal?.status !== 'active') throw new Error('there is no active durable goal to check');
  const check = directGoalCheckSchema.parse(raw);
  if (check.status === 'achieved' && goal.successCriteria && !check.criteriaEvidence) {
    throw new Error('criteriaEvidence is required for achieved because the goal has success criteria');
  }
  return check;
}

/** Receipt ties the accepted tool result to the goal the producing request saw. */
export function directGoalCheckReceipt(state: DirectGoalState): string {
  if (!state.goal) throw new Error('Cannot acknowledge a check without a goal');
  return `${DIRECT_GOAL_CHECK_PREFIX} [goal ${state.goal.id}]`;
}

/**
 * Build for one root model request, never for nested/scripted tool execution.
 * `requestGoal` is immutable request-local data, not a getter for the newest request.
 * Execution acknowledges only; the stop seam is the sole achieved-write path.
 */
export function createDirectGoalCheckTool(deps: {
  readonly requestGoal: DirectGoalState;
  readonly readGoal: () => DirectGoalState;
}): Tool<DirectGoalCheck> & { readonly parallelSafe: false } {
  const request = { ...deps.requestGoal, goal: deps.requestGoal.goal && { ...deps.requestGoal.goal } };
  return {
    spec: {
      name: 'goal_check',
      description: GOAL_CHECK_DESCRIPTION,
      inputSchema: z.toJSONSchema(directGoalCheckSchema),
    },
    parallelSafe: false,
    parse: (raw) => directGoalCheckSchema.parse(raw),
    approval: () => ({ kind: 'none' }),
    async execute(raw) {
      const current = deps.readGoal();
      try {
        const check = parseDirectGoalCheck(raw, current.goal);
        if (request.generation !== current.generation || request.goal?.id !== current.goal?.id) {
          throw new Error(GOAL_CHANGED_PROBLEM);
        }
        // Model-facing text is legacy's, word for word.
        const guidance = {
          achieved:
            'achieved proposed. The harness evaluates completion when you end the turn now; more tool work first means checking again. End the turn now with a short summary of the evidence.',
          blocked:
            'blocked. Control returns to the user. End the turn now and state plainly what is blocking and what input or capability is needed.',
          not_achieved:
            'not achieved. Continue working toward the outcome now, within the user instructions and approvals, and call goal_check again before ending the turn.',
          deferred:
            'deferred. The durable goal stays active and unchanged. Finish the user’s latest request and end the turn.',
        };
        return { output: `${directGoalCheckReceipt(request)} ${guidance[check.status]}`, isError: false };
      } catch (error) {
        const guidance = !current.goal
          ? ' Continue the ordinary request/tool workflow without goal_check; this tool does not create a goal.'
          : '';
        return {
          output: `Error: goal_check was not recorded: ${
            error instanceof Error ? error.message : String(error)
          }.${guidance}`,
          isError: true,
        };
      }
    },
  };
}
