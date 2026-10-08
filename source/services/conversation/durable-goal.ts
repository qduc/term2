import { randomUUID } from 'node:crypto';
import type { DurableGoal, GoalChangedEvent, GoalStatus } from '../logging/conversation-log-events.js';

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

/** The `/goal` status line, shared by every surface that reports a goal. */
export function formatGoalStatus(goal: DurableGoal): string {
  return `Goal (${goal.status}): ${goal.outcome}${
    goal.successCriteria ? `\nSuccess criteria: ${goal.successCriteria}` : ''
  }`;
}

/** How the TUI and non-interactive mode announce a goal closed by the model's self-check. */
export function formatGoalClosedByCheck(goal: DurableGoal): string {
  return `${formatGoalStatus(goal)}\nMarked achieved by the model's goal_check. Use /goal set to start a new goal.`;
}

/** Who wrote a goal change; see `GoalChangedEvent.source`. */
export type GoalChangeSource = NonNullable<GoalChangedEvent['source']>;

/**
 * Where a root client hands over a goal that a recorded achieved `goal_check`
 * closed. The active surface (the TUI or non-interactive mode) installs the
 * handler and persists the goal through its own goal-write path, the same one
 * `/goal achieved` or the launch goal uses. With no handler nothing is written.
 */
export interface GoalAchievedSlot {
  handler?: (goal: DurableGoal) => void;
}
