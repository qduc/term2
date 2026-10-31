/**
 * The direct turn: one model call, one event stream, no persistence.
 *
 * `events` never throws and always ends with `turn_ended`, including when
 * `models.resolve` fails. The caller is the only consumer.
 *
 * At M1 a model tool call ends the turn `failed` and is not yielded as an item,
 * so no orphan call can reach a later request. `answer`, `steer` and tool events
 * arrive with M2 and M3.
 */

import type { Item, ModelError, ModelRef, ModelRegistry, ReasoningEffort, ToolSpec, Usage } from '../model/index.js';
import type { TurnId } from './index.js';

export type TurnSpec = {
  readonly turnId: TurnId;
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly instructions: string;
  readonly model: ModelRef;
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
};

export type TurnResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: ModelError };

export type TurnEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'reasoning_delta'; readonly delta: string }
  | { readonly type: 'item'; readonly item: Item }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'turn_ended'; readonly result: TurnResult };

export type TurnHandle = {
  readonly events: AsyncIterable<TurnEvent>;
  cancel(): void;
};

export function startTurn(_spec: TurnSpec, _models: ModelRegistry): TurnHandle {
  throw new Error('startTurn is not implemented yet (M1 task 5)');
}
