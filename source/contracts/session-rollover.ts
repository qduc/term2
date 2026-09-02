export type SessionRolloverReason = 'context_pressure' | 'task_boundary';

export interface SessionRolloverRequest {
  brief: string;
  reason?: SessionRolloverReason;
}

export interface PendingSessionRolloverRequest extends SessionRolloverRequest {
  rolloverId: string;
  requestedAt: number;
  providerInputTokens?: number;
}

export type SessionRolloverRequestOutcome =
  | { ok: true; status: 'rollover_requested'; rolloverId: string }
  | {
      ok: false;
      status: 'rollover_blocked';
      error: string;
      active: { shell: number; subagent: number };
      rolloverId: string;
    };

export type SessionRolloverConsumption =
  | { status: 'none' }
  | { status: 'ready'; request: PendingSessionRolloverRequest }
  | {
      status: 'blocked';
      blocker: 'background_work' | 'pending_interaction';
      error: string;
      active?: { shell: number; subagent: number };
      request: PendingSessionRolloverRequest;
    };
