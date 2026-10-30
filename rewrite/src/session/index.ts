/**
 * session/ — one conversation, durable.
 *
 * The single source of truth is an append-only log of facts. History, status,
 * the pending interaction, the input queue and retry eligibility are all
 * projections of that log, computed by one pure reducer. Resume means
 * replaying the log; an in-flight turn resumes from its last checkpoint.
 * Depends on: engine, model, tools, config.
 */

import type { Item, ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type { ApprovalDecision, ApprovalRequest, EngineEvent, TurnCheckpoint, TurnId } from '../engine/index.js';

export type SessionId = string & { readonly __brand: 'SessionId' };
export type ClientRequestId = string & { readonly __brand: 'ClientRequestId' };
export type InteractionId = string & { readonly __brand: 'InteractionId' };

// ---------- The log ----------

/** What gets persisted. Transient engine events (deltas, progress) are not facts. */
export type SessionFact =
  | { readonly type: 'session_created'; readonly workspace: Workspace; readonly model: ModelRef }
  | { readonly type: 'input_queued'; readonly requestId: ClientRequestId; readonly items: readonly Item[] }
  | { readonly type: 'turn_started'; readonly turnId: TurnId; readonly requestId: ClientRequestId | null }
  | { readonly type: 'item_committed'; readonly turnId: TurnId; readonly item: Item }
  | { readonly type: 'checkpoint_saved'; readonly checkpoint: TurnCheckpoint }
  | {
      readonly type: 'interaction_opened';
      readonly turnId: TurnId;
      readonly interactionId: InteractionId;
      readonly approvals: readonly ApprovalRequest[];
    }
  | {
      readonly type: 'interaction_resolved';
      readonly interactionId: InteractionId;
      readonly decisions: readonly { readonly callId: ApprovalRequest['callId']; readonly decision: ApprovalDecision }[];
    }
  | { readonly type: 'turn_ended'; readonly turnId: TurnId; readonly outcome: 'completed' | 'cancelled' | 'failed' | 'budget_exhausted' }
  /** Written on recovery when a turn cannot be resumed safely. */
  | { readonly type: 'turn_interrupted'; readonly turnId: TurnId; readonly reason: string }
  | { readonly type: 'history_compacted'; readonly history: readonly Item[] }
  | { readonly type: 'model_changed'; readonly model: ModelRef };

export type LogEntry = {
  readonly seq: number;
  readonly at: string;
  readonly fact: SessionFact;
};

export interface SessionLog {
  /** Appends atomically and durably; returns the assigned sequence numbers. */
  append(facts: readonly SessionFact[]): Promise<readonly number[]>;
  read(fromSeq?: number): AsyncIterable<LogEntry>;
  readonly lastSeq: number;
}

// ---------- Projection ----------

export type SessionStatus = 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';

export type PendingInteraction = {
  readonly interactionId: InteractionId;
  readonly turnId: TurnId;
  readonly approvals: readonly ApprovalRequest[];
};

export type SessionState = {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly history: readonly Item[];
  readonly activeTurnId: TurnId | null;
  readonly pendingInteraction: PendingInteraction | null;
  readonly queue: readonly { readonly requestId: ClientRequestId; readonly items: readonly Item[] }[];
  /** The last turn failed or was interrupted before committing output. */
  readonly canRetry: boolean;
  readonly lastCheckpoint: TurnCheckpoint | null;
  readonly lastSeq: number;
};

/** The one reducer. Every client and every recovery path goes through it. */
export type Project = (state: SessionState, entry: LogEntry) => SessionState;

// ---------- Live session ----------

/** A log fact, or a transient engine event, delivered to subscribers in order. */
export type SessionUpdate =
  | { readonly kind: 'fact'; readonly entry: LogEntry }
  | { readonly kind: 'live'; readonly turnId: TurnId; readonly event: EngineEvent };

export type Admission =
  | { readonly kind: 'started'; readonly turnId: TurnId }
  | { readonly kind: 'queued'; readonly position: number }
  /** Same `ClientRequestId` seen before; nothing new happened. */
  | { readonly kind: 'duplicate'; readonly turnId: TurnId | null }
  | { readonly kind: 'rejected'; readonly reason: 'queue_full' | 'closed' };

export interface Session {
  readonly id: SessionId;
  state(): SessionState;
  submit(requestId: ClientRequestId, items: readonly Item[]): Promise<Admission>;
  decide(
    interactionId: InteractionId,
    decisions: readonly { readonly callId: ApprovalRequest['callId']; readonly decision: ApprovalDecision }[],
  ): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<Admission>;
  compact(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  /** Replays from `fromSeq`, then streams live. Returns an unsubscribe function. */
  subscribe(fromSeq: number, listener: (update: SessionUpdate) => void): () => void;
  close(): Promise<void>;
}

export type SessionSummary = Pick<SessionState, 'id' | 'status' | 'workspace' | 'lastSeq'> & {
  readonly title: string | null;
  readonly updatedAt: string;
};

export interface SessionStore {
  create(workspace: Workspace, model: ModelRef): Promise<Session>;
  /**
   * Opens an existing session and reconciles it: a turn with a checkpoint
   * whose pending tools are all idempotent resumes; otherwise it is marked
   * `turn_interrupted`. A pending interaction is restored as-is.
   */
  open(id: SessionId): Promise<Session>;
  list(cursor?: string): Promise<{ readonly sessions: readonly SessionSummary[]; readonly nextCursor: string | null }>;
}
