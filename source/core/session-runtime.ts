/**
 * Internal core seam for composing a session runtime.
 *
 * Keep this entry free of CLI, Ink, React, and terminal construction. The
 * implementation remains in the existing session composition root until a
 * narrower external session port is justified.
 */
export { createSessionRuntime } from '../services/session/session-composition.js';
export type {
  BackgroundSubagentApprovalChannel,
  CreateConversationSessionOptions,
  SessionApprovalQuery,
  SessionLogs,
  SessionRuntime,
} from '../services/session/session-composition.js';

import type { UserTurn } from '../types/user-turn.js';

/** The prepared admission result exposed by the in-process session seam. */
export type Prepared = {
  readonly kind: 'prepared';
  readonly leaseId: string;
  readonly turnId: string;
};

/** A rejected admission and its bounded reason. */
export type Rejected = {
  readonly kind: 'rejected';
  readonly reason: 'busy' | 'queue_full' | 'closed';
};

export type InteractionDecision = {
  readonly expectedInteractionId: number;
  readonly expectedRevision?: number;
  readonly answer: string;
  readonly rejectionReason?: string;
  readonly approvalAnswer?: string;
};

export type InteractionResult =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'stale_interaction';
      readonly expectedInteractionId: number;
      readonly currentInteractionId: number;
    }
  | {
      readonly kind: 'awaiting_next_question';
      readonly interactionId: number;
      readonly snapshot: object;
    }
  | {
      readonly kind: 'resolved';
      readonly interactionId: number;
      readonly approval: object;
      readonly answer: string;
      readonly rejectionReason?: string;
      readonly approvalAnswer?: string;
    };

export type SessionEvent = { readonly type: string; readonly [key: string]: unknown };
export type SessionSnapshot = object;
export type QueuedTurnStart = {
  readonly requestId: string;
  readonly input: string | UserTurn;
  readonly suppressUserMessageDisplay?: boolean;
};

/**
 * The narrow, in-process projection used by gateway session lifecycle code.
 * It is backed by an existing conversation runtime; it does not construct one.
 */
export interface SessionHandle {
  readonly sessionId: string;
  readonly sessionStartedAt: string;
  prepare(
    input: string | UserTurn,
    ids: { readonly turnId: string; readonly clientRequestId: string },
  ): Promise<Prepared | Rejected>;
  commit(leaseId: string): Promise<void>;
  cancelPrepared(leaseId: string): Promise<void>;
  resolveInteraction(request: InteractionDecision): InteractionResult;
  snapshot(): SessionSnapshot;
  setEventSink(sink: ((event: SessionEvent) => void | PromiseLike<void>) | null): void;
  setQueuedTurnStartObserver(observer: ((start: QueuedTurnStart) => void) | null): void;
  closeAdmission(): void;
  reopenAdmission(): void;
  abortAndDiscard(): Promise<{ readonly proven: boolean; readonly discardedTurnIds: string[] }>;
  shutdown(): Promise<void>;
}
