/** The durable goal shared by request snapshots, goal tools, and session persistence. */
export interface DurableGoal {
  id: string;
  outcome: string;
  successCriteria?: string;
  status: GoalStatus;
}

export type GoalStatus = 'active' | 'achieved' | 'abandoned';

export const MAX_GOAL_FIELD_LENGTH = 2000;
