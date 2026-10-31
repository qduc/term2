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

import { startTurn } from '../engine/index.js';
import type { TurnEvent, TurnHandle, TurnId, TurnResult, TurnSpec } from '../engine/index.js';
import type { Item, ModelError, ModelRegistry } from '../model/index.js';
import type { Fact, SessionStartedFact } from './facts.js';
import type { ConversationLog } from './log.js';
import { replay } from './replay.js';

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
  deps: ConversationDeps & { readonly meta: Omit<SessionStartedFact, 'type'> },
): Conversation {
  const started: Fact = { type: 'session_started', ...deps.meta };
  deps.log.append([started]);
  return conversation(deps, deps.meta.id, [started]);
}

/** Writes nothing until the next `run`, which records any interruption with its `turn_started`. */
export function openConversation(deps: ConversationDeps & { readonly facts: readonly Fact[] }): Conversation {
  const started = deps.facts.find((fact) => fact.type === 'session_started');
  if (started?.type !== 'session_started') throw new Error(`${deps.log.path} has no session_started fact`);
  return conversation(deps, started.id, [...deps.facts]);
}

function conversation(deps: ConversationDeps, id: string, facts: Fact[]): Conversation {
  let activeTurn = false;
  let logFailure: ModelError | null = null;

  /** A short write leaves an unterminated line, so nothing may follow a failed append. */
  const commit = (next: readonly Fact[]): boolean => {
    if (logFailure) return false;
    try {
      deps.log.append(next);
      facts.push(...next);
      return true;
    } catch (error) {
      logFailure = {
        kind: 'provider',
        message: `conversation log: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      };
      return false;
    }
  };

  async function* drive(turnId: TurnId, handle: TurnHandle): AsyncGenerator<TurnEvent, void> {
    let ended = false;
    try {
      let result: TurnResult = lostTerminal;
      try {
        for await (const event of handle.events) {
          if (event.type === 'turn_ended') {
            result = event.result;
            break;
          }
          const fact = factFor(turnId, event);
          if (fact && !commit([fact])) {
            handle.cancel();
            break;
          }
          yield event;
        }
      } catch (error) {
        result = {
          kind: 'failed',
          error: {
            kind: 'provider',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };
      }
      commit([terminalFact(turnId, result)]);
      ended = true;
      activeTurn = false;
      yield { type: 'turn_ended', result: logFailure ? { kind: 'failed', error: logFailure } : result };
    } finally {
      if (!ended) handle.cancel();
      activeTurn = false;
    }
  }

  return {
    id,
    run(request) {
      if (activeTurn) throw new Error(`conversation ${id} already has an active turn`);
      const { history, nextTurn } = replay(facts);
      const turnId = `turn-${nextTurn}` as TurnId;
      const unended = unendedTurn(facts);
      const opening: Fact[] = [
        ...(unended ? [{ type: 'turn_ended', turnId: unended, outcome: 'interrupted' } as const] : []),
        { type: 'turn_started', turnId, input: request.input },
      ];
      if (!commit(opening)) return failedTurn(logFailure!);
      activeTurn = true;
      const { input, notice, ...settings } = request;
      const handle = startTurn(
        { ...settings, turnId, history, newItems: notice ? withNotice(input, notice) : input },
        deps.models,
      );
      return { events: drive(turnId, handle), cancel: handle.cancel };
    },
    close() {
      deps.log.close();
    },
  };
}

const lostTerminal: TurnResult = {
  kind: 'failed',
  error: { kind: 'provider', message: 'turn ended without a terminal event', retryable: false },
};

function failedTurn(error: ModelError): Turn {
  return {
    events: (async function* () {
      yield { type: 'turn_ended', result: { kind: 'failed', error } } as const;
    })(),
    cancel() {},
  };
}

/** Reasoning deltas stay live-only; everything else that happens in a turn is durable. */
function factFor(turnId: TurnId, event: Exclude<TurnEvent, { type: 'turn_ended' }>): Fact | null {
  if (event.type === 'text_delta') return { type: 'text_delta', turnId, delta: event.delta };
  if (event.type === 'item') return { type: 'item', turnId, item: event.item };
  if (event.type === 'usage') return { type: 'usage', turnId, usage: event.usage };
  return null;
}

function terminalFact(turnId: TurnId, result: TurnResult): Fact {
  return {
    type: 'turn_ended',
    turnId,
    outcome: result.kind,
    ...(result.kind === 'failed' ? { error: result.error } : {}),
  };
}

function unendedTurn(facts: readonly Fact[]): TurnId | null {
  for (let index = facts.length - 1; index >= 0; index--) {
    const fact = facts[index]!;
    if (fact.type === 'turn_ended') return null;
    if (fact.type === 'turn_started') return fact.turnId;
  }
  return null;
}

/** The notice joins the prompt in one text part, as the provider saw it from the old CLI. */
function withNotice(input: readonly Item[], notice: string): readonly Item[] {
  let prefixed = false;
  return input.map((item) => {
    if (prefixed || item.type !== 'user_message') return item;
    const textIndex = item.content.findIndex((part) => part.type === 'text');
    const part = item.content[textIndex];
    if (part?.type !== 'text') return item;
    prefixed = true;
    const content = [...item.content];
    content[textIndex] = { ...part, text: `${notice}\n\n${part.text}` };
    return { ...item, content };
  });
}
