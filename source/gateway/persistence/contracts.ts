export type GatewaySessionStatus =
  | 'initializing'
  | 'idle'
  | 'running'
  | 'awaiting_interaction'
  | 'interrupted'
  | 'closed';

export type GatewaySessionRecord = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly grantVersion: string;
  readonly bindingFingerprint: string;
  readonly status: GatewaySessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAppendedSequence: number;
  readonly lastPublishedSequence: number;
  readonly firstRetainedEventSequence: number;
  readonly projectionSequence: number;
  readonly transcriptGeneration: number;
  readonly activeTurnId?: string;
  readonly interruptedAt?: string;
  readonly recoveryWarning?: string;
  readonly retentionEligibleAt?: string;
};

export type SessionListItem = Pick<
  GatewaySessionRecord,
  'id' | 'workspaceId' | 'status' | 'createdAt' | 'updatedAt'
> & { readonly latestSequence: number };

export type SessionListPage = {
  readonly sessions: readonly SessionListItem[];
  readonly nextCursor: string | null;
};

export type AdmissionState = 'prepared' | 'accepted' | 'committed' | 'terminal' | 'rejected';
export type AdmissionResult = 'accepted' | 'replayed' | 'queue_discarded' | 'failed' | 'aborted';
export type AdmissionPhase = 'prepared' | 'transcript_written' | 'journal_written' | 'committed';

export type AdmissionRecord = {
  readonly ownerUserId: string;
  readonly sessionId: string;
  readonly clientRequestId: string;
  readonly normalizedBodyHash: string;
  readonly turnId: string;
  readonly state: AdmissionState;
  readonly result?: AdmissionResult;
  readonly phase?: AdmissionPhase;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly transcriptChecksum?: string;
  readonly journalChecksum?: string;
};

export type AgentEventType =
  | 'session_created'
  | 'user_message_accepted'
  | 'user_message_rejected'
  | 'assistant_started'
  | 'text_delta'
  | 'reasoning_delta'
  | 'tool_started'
  | 'command_message'
  | 'approval_required'
  | 'interaction_updated'
  | 'interaction_resolved'
  | 'interaction_recovered'
  | 'usage_update'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_aborted';

export const FROZEN_AGENT_EVENT_TYPES = [
  'session_created',
  'user_message_accepted',
  'user_message_rejected',
  'assistant_started',
  'text_delta',
  'reasoning_delta',
  'tool_started',
  'command_message',
  'approval_required',
  'interaction_updated',
  'interaction_resolved',
  'interaction_recovered',
  'usage_update',
  'turn_completed',
  'turn_failed',
  'turn_aborted',
] as const;

export type AgentEventEnvelope = {
  readonly schemaVersion: 1;
  readonly id: number;
  readonly sessionId: string;
  readonly type: AgentEventType;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type DurableEventCandidate = Omit<AgentEventEnvelope, 'id' | 'occurredAt' | 'schemaVersion'> & {
  readonly occurredAt?: string;
};

export type ReloadRequiredReason = 'cursor_compacted' | 'sequence_gap' | 'generation_mismatch' | 'journal_unhealthy';

export type ReplayLiveSubscription =
  | {
      readonly kind: 'subscribed';
      readonly replay: readonly AgentEventEnvelope[];
      readonly replayHighWater: number;
      readonly firstRetainedEventSequence: number;
      readonly unsubscribe: () => void;
    }
  | {
      readonly kind: 'reload_required';
      readonly reason: ReloadRequiredReason;
      readonly firstRetainedEventSequence: number;
      readonly latestSequence: number;
    };

export type PersistenceHighWater = {
  readonly lastAppendedSequence: number;
  readonly lastPublishedSequence: number;
  readonly firstRetainedEventSequence: number;
  readonly projectionSequence: number;
};

export class GatewayPersistenceError extends Error {
  readonly code:
    | 'unsafe_root'
    | 'integrity_failed'
    | 'not_found'
    | 'owner_mismatch'
    | 'conflict'
    | 'readonly'
    | 'corrupt'
    | 'storage_capacity'
    | 'cursor_invalid'
    | 'cursor_compacted'
    | 'journal_unhealthy';
  constructor(code: GatewayPersistenceError['code'], message = 'gateway persistence rejected the operation') {
    super(message);
    this.name = 'GatewayPersistenceError';
    this.code = code;
  }
}

export interface GatewayEventJournal {
  append(
    event: DurableEventCandidate,
    options: { durability: 'critical' | 'stream' },
  ): Promise<{ id: number; fsynced: boolean }>;
  flush(): Promise<void>;
  highWater(): PersistenceHighWater;
  subscribeFrom(
    after: number | null,
    listener: (event: AgentEventEnvelope) => void,
    expectedTranscriptGeneration?: number,
  ): ReplayLiveSubscription;
  assertHealthy(): void;
}
