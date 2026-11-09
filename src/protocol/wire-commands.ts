/** Public command envelopes and receipts; data vocabulary stays in wire.ts. */
import type {
  WireAdmission,
  WireAnswerProvenance,
  WireBudgetDecision,
  WireCancelTarget,
  WireCommandPreconditions,
  WireCommandReceipt,
  WireContent,
  WireDecision,
  WireModel,
  WireNativeCommandOutcome,
  WireNotificationDrainResult,
  WireNotice,
  WireOrigin,
  WireRewindTarget,
} from './wire.js';

/** Selectable reasoning values for the configure command, including provider default. */
export const WIRE_REASONING_SELECTIONS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Requested configure selection only. Accepted output uses WireConfiguration. */
export type WireConfigureRequest = {
  readonly model?: WireModel;
  readonly reasoning?: (typeof WIRE_REASONING_SELECTIONS)[number];
  readonly temperature?: number;
  readonly profileId?: string;
};

export type WireSubmission = {
  readonly requestId: string;
  readonly text: string;
  readonly attachments?: readonly WireContent[];
  readonly origin?: WireOrigin;
  readonly delivery?: 'auto' | 'steer' | 'follow_up' | 'reject_if_busy';
  readonly expectedSteerTurnId?: string;
};
export type WireCommand =
  | ({ readonly type: 'submit' } & WireSubmission)
  | {
      readonly type: 'answer';
      readonly requestId: string;
      readonly decision: WireDecision;
      readonly provenance?: WireAnswerProvenance;
    }
  | {
      readonly type: 'answer_budget';
      readonly requestId: string;
      readonly decision: WireBudgetDecision;
      readonly provenance?: WireAnswerProvenance;
    }
  | {
      readonly type: 'cancel';
      readonly target?: WireCancelTarget;
      readonly expectedTurnId?: string;
      readonly discardQueue?: boolean;
      readonly returnSteers?: boolean;
    }
  | ({
      readonly type: 'retry';
      readonly commandId: string;
      readonly target: 'turn' | 'tool';
      readonly executionId?: string;
    } & WireCommandPreconditions)
  | ({ readonly type: 'compact'; readonly commandId: string } & WireCommandPreconditions)
  | ({
      readonly type: 'configure';
      readonly commandId: string;
      readonly configuration: WireConfigureRequest;
    } & WireCommandPreconditions)
  | {
      readonly type: 'queue_edit';
      readonly messageId: string;
      readonly text: string;
      readonly attachments?: readonly WireContent[];
    }
  | { readonly type: 'queue_retract'; readonly messageId: string }
  | { readonly type: 'queue_resume' }
  | { readonly type: 'queue_discard' }
  | {
      readonly type: 'task_control';
      readonly taskId: string;
      readonly action: 'cancel' | 'check_in' | 'foreground' | 'background';
    }
  | { readonly type: 'command_status'; readonly commandId: string }
  | { readonly type: 'command_revision' }
  | { readonly type: 'drain_background_notifications'; readonly requestId: string }
  | { readonly type: 'list_rewind_targets' }
  | ({ readonly type: 'rewind'; readonly commandId: string; readonly targetId: string } & WireCommandPreconditions)
  | { readonly type: 'reset' }
  | ({ readonly type: 'rollover'; readonly commandId: string } & WireCommandPreconditions)
  | { readonly type: 'preview'; readonly text: string; readonly attachments?: readonly WireContent[] };
export type WireCommandErrorCode =
  | 'invalid_command'
  | 'unavailable'
  | 'stale_interaction'
  | 'request_conflict'
  | 'rejected'
  | 'closed'
  | 'not_found'
  | 'forbidden'
  | 'storage_failure'
  | 'too_late'
  | 'internal_error'
  | 'replay_unavailable'
  | 'not_admitting'
  | 'command_rejected'
  | 'command_interrupted';
export type WireCommandResult =
  | { readonly ok: true; readonly kind: 'admitted'; readonly admission: WireAdmission }
  | { readonly ok: true; readonly kind: 'accepted' }
  /** Exact admission/empty/busy result, not completion of the silent model turn. */
  | {
      readonly ok: true;
      readonly kind: 'background_drain';
      readonly result: Exclude<WireNotificationDrainResult, { readonly kind: 'not_admitting' }>;
    }
  /** Atomic Session receipt, not a terminal or a promise that physical cleanup finished. */
  | {
      readonly ok: true;
      readonly kind: 'abort';
      readonly result:
        | {
            readonly kind: 'aborted';
            readonly turnId: string;
            readonly discardedMessageIds: readonly string[];
            readonly returnedSteers?: readonly {
              readonly messageId: string;
              readonly clientRequestId: string;
              readonly content: readonly WireContent[];
            }[];
          }
        | {
            readonly kind: 'no_op';
            readonly turnId: string;
            readonly status: 'terminal_accepted' | 'cancellation_requested' | 'not_current';
            readonly reason?: string;
          }
        | { readonly kind: 'not_admitting'; readonly reason?: string };
    }
  | { readonly ok: true; readonly kind: 'rewind_targets'; readonly targets: readonly WireRewindTarget[] }
  | {
      readonly ok: true;
      readonly kind: 'preview';
      readonly notices: readonly (WireNotice & { readonly estimatedTokens?: number })[];
      readonly requiresConfirmation: boolean;
    }
  | { readonly ok: true; readonly kind: 'session_changed'; readonly sessionId: string }
  /** Current native root-history/configuration revision for atomic mutations. */
  | { readonly ok: true; readonly kind: 'command_revision'; readonly revision: string }
  /** Pending means receipt-owned work, not command success or turn completion. */
  | {
      readonly ok: true;
      readonly kind: 'command_pending';
      readonly replayed?: boolean;
      readonly receipt: WireCommandReceipt;
    }
  | {
      readonly ok: true;
      readonly kind: 'command_finished';
      readonly replayed?: boolean;
      readonly receipt: WireCommandReceipt & {
        readonly outcome: Exclude<WireNativeCommandOutcome, { readonly kind: 'rejected' | 'interrupted' }>;
      };
    }
  | {
      readonly ok: false;
      readonly code: 'command_rejected' | 'command_interrupted';
      readonly replayed?: boolean;
      readonly commandId: string;
      readonly message: string;
      readonly receipt: WireCommandReceipt & { readonly outcome: WireNativeCommandOutcome };
    }
  | {
      readonly ok: false;
      readonly code: Exclude<WireCommandErrorCode, 'command_rejected' | 'command_interrupted'>;
      readonly message: string;
      readonly commandId?: string;
    };
