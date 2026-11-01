/** Session-owned admission data. No live handles, acceptance tokens or provider state. */
import type { TurnId } from '../engine/index.js';
import type { ContentPart, Item } from '../model/index.js';
import type { DirectAdmission, DirectSubmission } from './facade-types.js';

export type DirectQueueDelivery = 'steer' | 'follow_up' | 'reject_if_busy';
export type DirectQueueSubmission = Omit<DirectSubmission, 'delivery'> & {
  /** Omission is a follow-up. Interactive callers must select their intended delivery. */
  readonly delivery?: DirectQueueDelivery | 'auto';
  /** Original human receipt time, never the later queue dispatch time. */
  readonly humanInputAt?: string;
};
export type DirectQueueAdmission = Extract<DirectAdmission, { readonly kind: 'started' | 'queued' | 'steering' }>;
export type DirectQueueOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type DirectQueueStage =
  | 'queued'
  | 'pending_steer'
  | 'running'
  | 'steered'
  | 'finished'
  | 'retracted'
  | 'discarded'
  | 'cancelled';
export type DirectQueuePause = 'manual' | 'failure' | 'recovered_interrupted';
export type DirectQueueRecord = {
  /** Original body retained for idempotence even after an edit or settlement. */
  readonly request: DirectQueueSubmission & { readonly delivery: DirectQueueDelivery };
  readonly messageId: string;
  readonly receivedAt?: string;
  /** Current executable payload, not a text-only display cache. */
  readonly content: readonly ContentPart[];
  readonly admission: DirectQueueAdmission;
  readonly stage: DirectQueueStage;
  readonly turnId?: TurnId;
  readonly outcome?: DirectQueueOutcome;
};
export type DirectQueueState = {
  readonly records: readonly DirectQueueRecord[];
  /** Steers precede follow-ups; each class keeps its receipt order. */
  readonly pending: readonly string[];
  readonly active?: {
    readonly messageId: string;
    readonly turnId: TurnId;
    readonly phase: 'running' | 'cancelling';
    readonly retainedMessageIds?: readonly string[];
  };
  readonly pause?: DirectQueuePause;
};

/** Add this union to Session Fact and its decoder. Only Session appends these facts. */
export type DirectQueueFact =
  | { readonly type: 'queue_submitted'; readonly record: DirectQueueRecord }
  | { readonly type: 'queue_edited'; readonly messageId: string; readonly content: readonly ContentPart[] }
  | { readonly type: 'queue_retracted'; readonly messageId: string }
  | { readonly type: 'queue_discarded'; readonly messageIds: readonly string[] }
  | {
      readonly type: 'queue_started';
      readonly messageId: string;
      readonly turnId: TurnId;
      /** Only the rotation header's correlated control handoff may bypass FIFO and pause. */
      readonly rolloverCommandId?: string;
    }
  | { readonly type: 'queue_steered'; readonly messageIds: readonly string[]; readonly turnId: TurnId }
  | {
      readonly type: 'queue_cancelling';
      readonly turnId: TurnId;
      readonly cancelledMessageIds: readonly string[];
      readonly retainedMessageIds: readonly string[];
    }
  | {
      readonly type: 'queue_settled';
      readonly turnId: TurnId;
      readonly outcome: DirectQueueOutcome;
      readonly preservePendingSteers?: boolean;
    }
  | { readonly type: 'queue_resumed' }
  | { readonly type: 'queue_recovered' };

/** Omitted attachments retain the prior parts; [] explicitly clears attachments. */
export type DirectQueueEdit =
  | { readonly text: string; readonly attachments?: readonly ContentPart[] }
  | { readonly content: readonly ContentPart[] };
export type DirectQueueCommand =
  | { readonly kind: 'edit'; readonly messageId: string; readonly edit: DirectQueueEdit }
  | { readonly kind: 'retract'; readonly messageId: string }
  /** Discard ordinary queued input, not pending active-turn steers or the foreground. */
  | { readonly kind: 'discard' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'dispatch' }
  | { readonly kind: 'boundary'; readonly turnId: TurnId }
  /** Foreground stop; a second untargeted stop resumes a retained manual pause. */
  | { readonly kind: 'cancel'; readonly turnId?: TurnId }
  /** Call only after physical cleanup AND the Session completion barrier. */
  | {
      readonly kind: 'settled';
      readonly turnId: TurnId;
      readonly outcome: DirectQueueOutcome;
      readonly preservePendingSteers?: boolean;
    }
  /** Reopen materialization, never an instruction to restart a run. */
  | { readonly kind: 'recover' };
export type DirectQueueMutation =
  | { readonly kind: 'accepted' | 'too_late' | 'no_op' }
  | { readonly kind: 'rejected'; readonly reason: 'invalid' };
export type DirectQueueEffect =
  | {
      readonly kind: 'start';
      readonly turnId: TurnId;
      readonly record: DirectQueueRecord;
      readonly input: readonly Item[];
    }
  | {
      readonly kind: 'steer';
      readonly turnId: TurnId;
      /** Raw history accepted by queue_steered itself; do not append duplicate item facts. */
      readonly input: readonly Item[];
      readonly modelInput: readonly Item[];
    }
  | { readonly kind: 'cancel'; readonly turnId: TurnId };
export type DirectQueuePlan<Result = DirectQueueMutation> = {
  readonly facts: readonly DirectQueueFact[];
  readonly state: DirectQueueState;
  readonly result: Result;
  /** Execute only after Session commits the plan and any companion turn-start facts. */
  readonly effect?: DirectQueueEffect;
};
export type DirectQueueEnvironment = {
  readonly newMessageId: () => string;
  readonly newTurnId: () => TurnId;
  readonly now: () => string;
  /** Ordinary queued admission only; omitted/unbounded matches the existing product default. */
  readonly capacity?: number;
  /** Session's compaction/restart reservation; never inferred from engine segments. */
  readonly dispatchHeld?: boolean;
};
