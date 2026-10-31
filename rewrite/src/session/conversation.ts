/**
 * One conversation: the only consumer of the engine stream and the only log
 * writer. Each event is appended before it is yielded, and `turn_ended` is
 * durable before `events` finishes.
 *
 * `run` throws while a turn is active. Any other failure, including a failed
 * append, surfaces as a final `turn_ended` with `kind: 'failed'` and never as a
 * throw from `events`. After a failed append nothing more is written, so that
 * final event is not in the log and replay reports `interrupted`.
 */

import type { TurnEvent, TurnSpec } from '../engine/index.js';
import type { ModelRegistry } from '../model/index.js';
import type { Fact, SessionStartedFact } from './facts.js';
import type { ConversationLog } from './log.js';

export type Turn = {
  readonly events: AsyncIterable<TurnEvent>;
  cancel(): void;
};

export type TurnRequest = Omit<TurnSpec, 'turnId' | 'history' | 'newItems'> & {
  /** Recorded in `turn_started` and replayed. */
  readonly input: TurnSpec['newItems'];
  /** Prefixed to a copy of `input` for this request only. Never logged. */
  readonly notice?: string;
};

export type Conversation = {
  readonly id: string;
  run(request: TurnRequest): Turn;
  close(): void;
};

export type ConversationDeps = {
  readonly log: ConversationLog;
  readonly models: ModelRegistry;
};

/** Writes `session_started`, and throws if that fails, so no provider call can follow. */
export function createConversation(
  _deps: ConversationDeps & { readonly meta: Omit<SessionStartedFact, 'type'> },
): Conversation {
  throw new Error('createConversation is not implemented yet (M1 task 5)');
}

/** Writes nothing until the next `run`, which records any interruption with its `turn_started`. */
export function openConversation(_deps: ConversationDeps & { readonly facts: readonly Fact[] }): Conversation {
  throw new Error('openConversation is not implemented yet (M1 task 5)');
}
