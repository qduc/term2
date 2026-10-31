/**
 * The durable vocabulary of a conversation log. Native facts, not source
 * LogEvents; nothing here goes through `SessionFact`, the reducer or the store.
 *
 * The profile notice is deliberately not a fact: `input` is the user's own
 * input, and history replays exactly that.
 */

import type { TurnId } from '../engine/index.js';
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
};

export type TurnOutcomeName = 'completed' | 'cancelled' | 'failed' | 'interrupted';

export type Fact =
  | SessionStartedFact
  | { readonly type: 'turn_started'; readonly turnId: TurnId; readonly input: readonly Item[] }
  /** Written but not fsynced. Replay turns unsuperseded deltas into an assistant message. */
  | { readonly type: 'text_delta'; readonly turnId: TurnId; readonly delta: string }
  | { readonly type: 'item'; readonly turnId: TurnId; readonly item: Item }
  | { readonly type: 'usage'; readonly turnId: TurnId; readonly usage: Usage }
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
