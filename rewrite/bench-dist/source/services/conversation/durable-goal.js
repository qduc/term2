import { randomUUID } from 'node:crypto';
export const MAX_GOAL_FIELD_LENGTH = 2000;
export function createDurableGoal(outcome, successCriteria, status = 'active') {
    const normalizedOutcome = outcome.trim();
    const normalizedCriteria = successCriteria?.trim();
    if (!normalizedOutcome)
        throw new Error('Goal outcome must not be empty.');
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
export function formatGoalStatus(goal) {
    return `Goal (${goal.status}): ${goal.outcome}${goal.successCriteria ? `\nSuccess criteria: ${goal.successCriteria}` : ''}`;
}
/** How the TUI and non-interactive mode announce a goal closed by the model's self-check. */
export function formatGoalClosedByCheck(goal) {
    return `${formatGoalStatus(goal)}\nCompletion accepted after the model's goal_check. Use /goal set to start a new goal.`;
}
//# sourceMappingURL=durable-goal.js.map