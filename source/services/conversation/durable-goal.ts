import { randomUUID } from 'node:crypto';
import type { DurableGoal, GoalStatus } from '../logging/conversation-log-events.js';

export const MAX_GOAL_FIELD_LENGTH = 2000;

export function createDurableGoal(
  outcome: string,
  successCriteria?: string,
  status: GoalStatus = 'active',
): DurableGoal {
  const normalizedOutcome = outcome.trim();
  const normalizedCriteria = successCriteria?.trim();
  if (!normalizedOutcome) throw new Error('Goal outcome must not be empty.');
  if (normalizedOutcome.length > MAX_GOAL_FIELD_LENGTH) {
    throw new Error(`Goal outcome must be at most ${MAX_GOAL_FIELD_LENGTH} characters.`);
  }
  if (normalizedCriteria && normalizedCriteria.length > MAX_GOAL_FIELD_LENGTH) {
    throw new Error(`Goal criteria must be at most ${MAX_GOAL_FIELD_LENGTH} characters.`);
  }
  return {
    id: randomUUID(),
    outcome: normalizedOutcome,
    ...(normalizedCriteria ? { successCriteria: normalizedCriteria } : {}),
    status,
  };
}
