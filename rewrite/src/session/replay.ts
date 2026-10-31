/**
 * The only producer of conversation history. Pure, so reopening writes nothing
 * and calls no provider.
 *
 * - `turn_started.input` enters history once; `item` facts follow it.
 * - Text deltas accumulate per turn. An `assistant_message` item clears them. At
 *   `turn_ended` or end of file, a nonempty remainder becomes one
 *   `assistant_message` with id `<turnId>-partial`.
 * - A last turn with no `turn_ended`, or ended `interrupted`, is `interrupted`.
 * - Reasoning fragments are not durable at M1 (M3 re-checks).
 *
 * `nextTurn` is the ordinal for the next `turn-N` id: 1 for an empty log and
 * one past the last started turn otherwise.
 */

import type { Item, ItemId } from '../model/index.js';
import type { TurnId } from '../engine/index.js';
import type { Fact, TurnOutcomeName } from './facts.js';

export type ReplayedConversation = {
  readonly status: 'idle' | 'interrupted';
  readonly history: readonly Item[];
  readonly nextTurn: number;
};

type ActiveTurn = {
  readonly turnId: TurnId;
  readonly deltas: string[];
};

export function replay(facts: readonly Fact[]): ReplayedConversation {
  const history: Item[] = [];
  let active: ActiveTurn | null = null;
  let turns = 0;
  let lastOutcome: TurnOutcomeName | null = null;

  const requireActive = (turnId: TurnId, type: string): ActiveTurn => {
    if (active === null) {
      throw new Error(`replay: ${type} for turn ${turnId} without an open turn`);
    }
    if (active.turnId !== turnId) {
      throw new Error(`replay: ${type} for turn ${turnId} while turn ${active.turnId} is open`);
    }
    return active;
  };

  const finish = (turn: ActiveTurn): void => {
    const text = turn.deltas.join('');
    if (text.length === 0) return;
    history.push({
      type: 'assistant_message',
      id: `${turn.turnId}-partial` as ItemId,
      content: [{ type: 'text', text }],
    });
  };

  for (const fact of facts) {
    switch (fact.type) {
      case 'session_started':
        // Session metadata does not enter history.
        break;

      case 'turn_started': {
        if (active !== null) {
          throw new Error(`replay: turn ${fact.turnId} started while turn ${active.turnId} has no turn_ended`);
        }
        turns += 1;
        lastOutcome = null;
        for (const item of fact.input) history.push(item);
        active = { turnId: fact.turnId, deltas: [] };
        break;
      }

      case 'text_delta': {
        const turn = requireActive(fact.turnId, 'text_delta');
        turn.deltas.push(fact.delta);
        break;
      }

      case 'item': {
        const turn = requireActive(fact.turnId, 'item');
        // The complete message supersedes the deltas that produced it.
        if (fact.item.type === 'assistant_message') turn.deltas.length = 0;
        history.push(fact.item);
        break;
      }

      case 'usage': {
        requireActive(fact.turnId, 'usage');
        break;
      }

      case 'turn_ended': {
        const turn = requireActive(fact.turnId, 'turn_ended');
        finish(turn);
        active = null;
        lastOutcome = fact.outcome;
        break;
      }

      default: {
        const type: unknown = (fact as { type?: unknown }).type;
        throw new Error(`replay: unknown fact type ${JSON.stringify(String(type))}`);
      }
    }
  }

  let status: ReplayedConversation['status'] = 'idle';
  if (active !== null) {
    finish(active);
    status = 'interrupted';
  } else if (lastOutcome === 'interrupted') {
    status = 'interrupted';
  }

  return { status, history, nextTurn: turns + 1 };
}
