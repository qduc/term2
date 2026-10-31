/**
 * The durable vocabulary of a conversation log. Native facts, not source
 * LogEvents; nothing here goes through `SessionFact`, the reducer or the store.
 *
 * The profile notice is deliberately not a fact: `input` is the user's own
 * input, and history replays exactly that.
 */

import type {
  TurnId,
  ExecutionId,
  InteractionDecision,
  InteractionRequest,
  InteractionRequestId,
} from '../engine/index.js';
import type { ToolResult } from '../tools/index.js';
import type { DirectBinding, DirectOrigin } from './facade-types.js';
import type { Item, ModelError, ModelRef, ReasoningEffort, Usage } from '../model/index.js';

export const LOG_FORMAT_VERSION = 1;

export type SessionStartedFact = {
  readonly type: 'session_started';
  readonly id: string;
  readonly workspace: string;
  readonly model: ModelRef;
  readonly reasoning?: ReasoningEffort;
  readonly profile: { readonly id: string; readonly version: string; readonly digest: string };
  readonly appVersion: string;
  /** Immutable client binding, validated by the store before writable open. */
  readonly binding?: DirectBinding;
};

/** Submission correlation is in the same durable line as turn admission. */
export type SubmissionMetadata = {
  readonly clientRequestId: string;
  /** ID of the submitted user item in turn_started.input. */
  readonly messageId: string;
  readonly origin?: DirectOrigin;
};

export type TurnOutcomeName = 'completed' | 'cancelled' | 'failed' | 'interrupted';

export type Fact =
  | SessionStartedFact
  | {
      readonly type: 'turn_started';
      readonly turnId: TurnId;
      readonly input: readonly Item[];
      readonly submission?: SubmissionMetadata;
    }
  /** Written but not fsynced. Replay turns unsuperseded deltas into an assistant message. */
  | { readonly type: 'text_delta'; readonly turnId: TurnId; readonly delta: string; readonly modelStep?: number }
  | {
      readonly type: 'item';
      readonly turnId: TurnId;
      readonly item: Item;
      readonly executionId?: ExecutionId;
      readonly modelStep?: number;
    }
  | {
      readonly type: 'tool_started';
      readonly turnId: TurnId;
      readonly executionId: ExecutionId;
      readonly parentExecutionId?: ExecutionId;
      readonly callId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_finished';
      readonly turnId: TurnId;
      readonly executionId: ExecutionId;
      readonly result: ToolResult;
    }
  | { readonly type: 'interaction_opened'; readonly turnId: TurnId; readonly request: InteractionRequest }
  | {
      readonly type: 'interaction_closed';
      readonly turnId: TurnId;
      readonly requestId: InteractionRequestId;
      readonly resolution: InteractionDecision | { readonly kind: 'cancelled' | 'interrupted' };
    }
  | { readonly type: 'usage'; readonly turnId: TurnId; readonly usage: Usage; readonly modelStep?: number }
  | {
      readonly type: 'turn_ended';
      readonly turnId: TurnId;
      readonly outcome: TurnOutcomeName;
      readonly error?: ModelError;
    };

/** One JSONL line. */
export type FactLine = {
  readonly v: typeof LOG_FORMAT_VERSION;
  readonly seq: number;
  readonly at: string;
  readonly fact: Fact;
};
