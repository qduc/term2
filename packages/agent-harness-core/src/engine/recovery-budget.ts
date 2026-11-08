/** Clean accounting leaf, reused without loading any legacy run driver. */
import {
  RunBudget,
  clampRunBudgetPolicy,
  type RunBudgetEvent,
  type RunBudgetPolicy,
} from './agent-runtime/run-budget.js';

export { RunBudget, clampRunBudgetPolicy };
export type {
  RunBudgetPolicy,
  RunBudgetEvent,
  RunBudgetEvidence,
  RunBudgetSnapshot,
  ToolStallObservation,
} from './agent-runtime/run-budget.js';
export type { ModelRequestCost } from '../shared/cost/model-cost.js';

export type DirectBudgetAction = 'observe' | 'pause' | 'wrap_up';

/**
 * Select the existing escalation action at the next request boundary. Never
 * abort an admitted tool. A pause is a Session-owned non-tool interaction;
 * pause the RunBudget clock during that wait and resume after durable answer.
 * A child in wrap-up mode gets its existing final tools-disabled response.
 */
export function directBudgetAction(input: {
  readonly policy: RunBudgetPolicy;
  readonly event: RunBudgetEvent;
  readonly wrapUpOnCritical: boolean;
}): DirectBudgetAction {
  const { policy, event } = input;
  if (policy.escalation === 'disabled') return 'observe';
  if (input.wrapUpOnCritical) {
    return event.type === 'budget_stage' && event.stage === 'critical' ? 'wrap_up' : 'observe';
  }
  if (policy.escalation === 'warn') return 'observe';
  if (policy.escalation === 'contain') {
    return event.type === 'budget_stage' && event.stage === 'critical' ? 'pause' : 'observe';
  }
  return event.type === 'tool_stall' || event.stage !== 'soft' ? 'pause' : 'observe';
}
