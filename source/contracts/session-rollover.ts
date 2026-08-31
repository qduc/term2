export type SessionRolloverReason = 'context_pressure' | 'task_boundary';

export interface SessionRolloverRequest {
  brief: string;
  reason?: SessionRolloverReason;
}

export type SessionRolloverRequestOutcome =
  | { ok: true; status: 'rollover_requested' }
  | {
      ok: false;
      status: 'rollover_blocked';
      error: string;
      active: { shell: number; subagent: number };
    };

export type SessionRolloverConsumption =
  | { status: 'none' }
  | { status: 'ready'; request: SessionRolloverRequest }
  | {
      status: 'blocked';
      blocker: 'background_work' | 'pending_interaction';
      error: string;
      active?: { shell: number; subagent: number };
    };
