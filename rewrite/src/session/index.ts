/**
 * session/ — one canonical conversation log and replay-derived session state.
 * Native engine checkpoints are never a restart authority. Provider history
 * and transcript decoding are adopted from source/services/conversation.
 */

import type { Item, ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type { EngineEvent, TurnId } from '../engine/index.js';
import type { ToolCallId } from '../model/index.js';
import type {
  PendingInteractionDto,
  SessionBinding,
  SessionEventReference,
  SessionFact,
  SessionLifecycleFact,
  SessionLogEntry,
} from './adopted/conversation-log.js';

export type { PendingInteractionDto, SessionBinding, SessionEventReference, SessionFact, SessionLifecycleFact };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type ClientRequestId = string & { readonly __brand: 'ClientRequestId' };
export type InteractionId = string & { readonly __brand: 'InteractionId' };
export type LogEntry = SessionLogEntry;

export type SessionStatus = 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';

export type PendingInteraction = {
  readonly turnId: TurnId;
  readonly interaction: PendingInteractionDto;
  readonly generation: string;
};

export type AdmissionRecord = {
  readonly clientRequestId: ClientRequestId;
  readonly normalizedBodyHash: string;
  readonly turnId: TurnId;
  readonly disposition: 'started' | 'queued';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly result?: 'accepted' | 'failed' | 'aborted' | 'queue_discarded';
};

export type SessionState = {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  /** Compatibility/UI view. Exact provider items are retained in providerHistory. */
  readonly history: readonly Item[];
  /** Complete adopted provider transcript, including opaque provider-native items. */
  readonly providerHistory: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly activeTurnId: TurnId | null;
  readonly pendingInteraction: PendingInteraction | null;
  readonly queue: readonly AdmissionRecord[];
  readonly admissions: Readonly<Record<string, AdmissionRecord>>;
  /** Retry eligibility supplied by the adopted ConversationService policy. */
  readonly canRetry: boolean;
  readonly binding: SessionBinding | null;
  readonly closedAt: string | null;
  readonly lastSeq: number;
};

/** The log owns writes and supplies stable event references for rollback facts. */
export interface SessionLog {
  append(facts: readonly SessionFact[]): Promise<readonly LogEntry[]>;
  read(fromSeq?: number): AsyncIterable<LogEntry>;
  flush(): Promise<void>;
  /** Releases the writer lock; this is not a logical session close. */
  dispose(): Promise<void>;
  readonly lastSeq: number;
}

export type Project = (state: SessionState, entry: LogEntry) => SessionState;

export type SessionUpdate =
  | { readonly kind: 'fact'; readonly entry: LogEntry }
  | { readonly kind: 'live'; readonly turnId: TurnId; readonly event: EngineEvent };

export type Admission =
  | { readonly kind: 'started'; readonly turnId: TurnId }
  | { readonly kind: 'queued'; readonly position: number }
  | { readonly kind: 'duplicate'; readonly turnId: TurnId | null }
  | { readonly kind: 'rejected'; readonly reason: 'queue_full' | 'closed' | 'request_conflict' };

export type SessionDecision = {
  readonly turnId: TurnId;
  readonly interactionId: InteractionId;
  readonly revision: number;
  readonly generation: string;
  readonly decisions: readonly { readonly callId: ToolCallId; readonly approve: boolean; readonly reason?: string }[];
};

export interface Session {
  readonly id: SessionId;
  state(): SessionState;
  submit(requestId: ClientRequestId, items: readonly Item[]): Promise<Admission>;
  decide(decision: SessionDecision): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<Admission>;
  compact(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  subscribe(fromSeq: number, listener: (update: SessionUpdate) => void): () => void;
  /** Disposes the live handle while retaining the conversation for later open. */
  close(): Promise<void>;
  /** Writes session_closed with one fixed retention deadline. */
  closeLog(closedAt?: string, retentionEligibleAt?: string): Promise<void>;
}

export type SessionSummary = Pick<SessionState, 'id' | 'status' | 'workspace' | 'lastSeq'> & {
  readonly title: string | null;
  readonly updatedAt: string;
};

export interface SessionStore {
  create(workspace: Workspace, model: ModelRef, binding?: SessionBinding): Promise<Session>;
  /** Replays the canonical log and durably marks an unfinished prior process interrupted before returning. */
  open(id: SessionId): Promise<Session>;
  list(cursor?: string): Promise<{ readonly sessions: readonly SessionSummary[]; readonly nextCursor: string | null }>;
}
