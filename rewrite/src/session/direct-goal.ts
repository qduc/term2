/** Root goal data and tools. Session supplies all state and accepts every write. */
import { z } from 'zod';
import { createDurableGoal, MAX_GOAL_FIELD_LENGTH } from '../../../source/services/conversation/durable-goal.js';
import { renderDurableGoalContext } from '../../../source/prompts/durable-goal-context.js';
import type { DurableGoal } from '../../../source/services/logging/conversation-log-events.js';
import type { Tool, ToolContext } from '../tools/index.js';

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

const field = z.string().trim().min(1).max(MAX_GOAL_FIELD_LENGTH);
export const directGoalCheckSchema = z.object({
  status: z.enum(['achieved', 'blocked', 'not_achieved', 'deferred']),
  evidence: field,
  criteriaEvidence: z.string().trim().max(MAX_GOAL_FIELD_LENGTH).optional(),
});
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
  return `${DIRECT_GOAL_CHECK_PREFIX} [goal ${state.goal.id}] [generation ${state.generation}]`;
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
      description:
        'Use only for an active durable session goal. Call by itself as the last tool call after all work and results. ' +
        'Report achieved with concrete outcome and criteria evidence, blocked with the exact missing input or capability, ' +
        'not_achieved to keep working, or deferred when newer user instructions take priority. Achieved proposes completion ' +
        'subject to harness verification; it grants no permission and does not override newer instructions.',
      inputSchema: z.toJSONSchema(directGoalCheckSchema),
    },
    parallelSafe: false,
    parse: (raw) => directGoalCheckSchema.parse(raw),
    approval: () => ({ kind: 'none' }),
    async execute(raw) {
      try {
        const current = deps.readGoal();
        const check = parseDirectGoalCheck(raw, current.goal);
        if (request.generation !== current.generation || request.goal?.id !== current.goal?.id) {
          throw new Error(
            'the session goal changed after this response began; check the current goal on the next request',
          );
        }
        const guidance = {
          achieved:
            'achieved proposed. End the turn now; the harness evaluates completion. More work requires checking again.',
          blocked: 'blocked. Return control and state exactly what input or capability is needed.',
          not_achieved: 'not achieved. Continue working within current permissions, then check again.',
          deferred: 'deferred. The goal remains active. Finish the latest user request and end the turn.',
        };
        return { output: `${directGoalCheckReceipt(request)} ${guidance[check.status]}`, isError: false };
      } catch (error) {
        return {
          output: `Error: goal_check was not recorded: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

const proposalSchema = z.object({ outcome: field, successCriteria: field.optional() });

/**
 * Propose once per Session, only with explicit live user approval. The proposal
 * fact precedes the prompt, so denial/cancellation/restart cannot offer it again.
 * Session must atomically enforce proposalMade as well as generation on writes.
 * approve must be a live Session interaction with a durable user-origin answer;
 * policy/auto-approval never counts as explicit approval. No adapter means unavailable.
 */
export function createDirectProposeGoalTool(deps: {
  readonly readGoal: () => DirectGoalState;
  readonly commit: DirectGoalWrite;
  readonly approve?: (
    goal: DurableGoal,
    context: ToolContext,
  ) => Promise<{
    readonly approved: boolean;
    readonly source: 'user' | 'policy' | 'system';
  }>;
}): Tool<z.infer<typeof proposalSchema>> & { readonly parallelSafe: false } {
  return {
    spec: {
      name: 'propose_goal',
      description:
        'Propose a durable outcome for explicit user approval only when moving from discussion into implementation. ' +
        'At most once per session, and only when no goal exists. Rejection changes no goal. Use /goal set to replace an existing goal.',
      inputSchema: z.toJSONSchema(proposalSchema),
    },
    parallelSafe: false,
    parse: (raw) => proposalSchema.parse(raw),
    approval: () => ({ kind: 'none' }),
    async execute(input, context) {
      const state = deps.readGoal();
      if (state.goal || state.proposalMade)
        return { output: 'Error: a goal exists or a proposal was already made. Use /goal set.', isError: true };
      if (!deps.approve)
        return { output: 'Error: explicit goal approval is unavailable. No goal was created.', isError: true };
      const goal = createDurableGoal(input.outcome, input.successCriteria);
      if (!(await deps.commit(state.generation, [{ type: 'goal_proposed', goal }]))) {
        return { output: 'Error: the goal proposal became stale; no goal was created.', isError: true };
      }
      const decision = await deps.approve(goal, context);
      if (!decision.approved || decision.source !== 'user' || context.signal.aborted)
        return {
          output: 'Goal proposal declined, not explicitly user-approved, or cancelled; no goal was created.',
          isError: false,
        };
      const current = deps.readGoal();
      if (
        current.goal ||
        current.generation !== state.generation ||
        !(await deps.commit(state.generation, [{ type: 'goal_changed', goal, source: 'proposal' }]))
      ) {
        return { output: 'Error: the goal changed while awaiting approval; no goal was replaced.', isError: true };
      }
      return { output: `Goal proposed and persisted with the user's approval: ${goal.outcome}`, isError: false };
    },
  };
}
