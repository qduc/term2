/**
 * The only producer of conversation history. Pure, so reopening writes nothing
 * and calls no provider.
 *
 * - `turn_started.input` enters history once; `item` facts follow it.
 * - Text deltas accumulate per turn. An `assistant_message` item clears them. At
 *   `turn_ended` or end of file, a nonempty remainder becomes one
 *   `assistant_message` with id `<turnId>-partial`.
 * - A last turn with no `turn_ended`, or ended `interrupted`, is `interrupted`.
 */

import type { Item } from '../model/index.js';
import type { Fact } from './facts.js';

export type ReplayedConversation = {
  readonly status: 'idle' | 'interrupted';
  readonly history: readonly Item[];
  readonly nextTurn: number;
};

export function replay(_facts: readonly Fact[]): ReplayedConversation {
  throw new Error('replay is not implemented yet (M1 task 2)');
}
