/** Native command data/proposals. Session alone grants ownership and persists/applies them. */
import type { ExecutionId, TurnId } from '../engine/index.js';
import type { ContentPart, Item, ItemId, ModelRef, ReasoningEffort } from '../model/index.js';
import type { DirectHistoryFact } from './facts.js';

export type DirectCommandConfiguration = {
  readonly model?: ModelRef;
  readonly reasoning?: ReasoningEffort;
  readonly temperature?: number;
};
export type DirectRolloverRequest = {
  readonly brief: string;
  readonly reason?: 'context_pressure' | 'task_boundary';
};
export type DirectCommandOperation =
  | { readonly kind: 'retry'; readonly target: 'turn' | 'tool'; readonly executionId?: ExecutionId }
  | { readonly kind: 'compact' }
  | { readonly kind: 'rewind'; readonly targetId: string }
  | { readonly kind: 'configure'; readonly configuration: DirectCommandConfiguration }
  | { readonly kind: 'rollover'; readonly request?: DirectRolloverRequest };
export type DirectCommandRequest = { readonly commandId: string; readonly operation: DirectCommandOperation };
export type DirectCommandOutcome =
  | { readonly kind: 'retried'; readonly turnId: TurnId }
  | { readonly kind: 'rewound'; readonly draft: { readonly content: readonly ContentPart[] } }
  | { readonly kind: 'compacted' }
  | { readonly kind: 'configured'; readonly configuration: DirectCommandConfiguration & { readonly model: ModelRef } }
  | { readonly kind: 'rolled_over'; readonly sessionId: string }
  | {
      readonly kind: 'rejected';
      readonly code: 'ineligible' | 'stale' | 'busy' | 'unavailable' | 'cancelled' | 'failed';
      readonly message: string;
    }
  | { readonly kind: 'interrupted'; readonly reason: 'outcome_unobserved' };
export type DirectCommandFact =
  | {
      readonly type: 'command_started';
      readonly commandId: string;
      readonly request: DirectCommandRequest;
      readonly revision: string;
    }
  | { readonly type: 'command_finished'; readonly commandId: string; readonly outcome: DirectCommandOutcome };
export type DirectCommandReceipt = {
  readonly request: DirectCommandRequest;
  readonly revision: string;
  readonly outcome?: DirectCommandOutcome;
};
export type DirectCommandReceipts = readonly DirectCommandReceipt[];

/** An immutable native capture taken AFTER Session has drained the foreground under command ownership. */
export type DirectCommandSnapshot = {
  readonly sessionId: string;
  /** Changes on root history/configuration/lifetime changes, not transient progress. */
  readonly revision: string;
  readonly history: readonly Item[];
  readonly executionsSettled: boolean;
  /** Original admitted user inputs, not synthetic personal-memory or goal notices. */
  readonly admissions: readonly {
    readonly messageId: ItemId;
    /** Last accepted input/context Item for this admission; includes persisted memory notices. */
    readonly retryThroughId: ItemId;
  }[];
  /** Root result identities from accepted item/execution audit, never provider call-ID guesses. */
  readonly toolResults: readonly { readonly executionId: ExecutionId; readonly itemId: ItemId }[];
};
export type DirectRewindTarget = {
  readonly id: string;
  readonly label: string;
  readonly messageId: ItemId;
  readonly discardedTurns: number;
  readonly discardedReplies: number;
  readonly imageCount: number;
};
export type DirectHistoryCommandPlan =
  | { readonly kind: 'rejected'; readonly code: 'ineligible' | 'stale' | 'busy'; readonly message: string }
  | {
      readonly kind: 'replace';
      readonly expectedRevision: string;
      readonly fact: DirectHistoryFact;
      readonly clearContinuity: true;
      readonly next:
        | { readonly kind: 'retry'; readonly input: readonly Item[] }
        | { readonly kind: 'rewound'; readonly draft: { readonly content: readonly ContentPart[] } };
    };

/** A repeated invocation returns its original receipt, never another execution grant. */
export type DirectCommandResult =
  | { readonly kind: 'pending' | 'finished'; readonly receipt: DirectCommandReceipt; readonly replayed: boolean }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'not_admitting'; readonly reason: string };
