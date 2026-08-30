export type SessionRolloverReason = 'context_pressure' | 'task_boundary';

export interface SessionRolloverRequest {
  brief: string;
  reason?: SessionRolloverReason;
}
