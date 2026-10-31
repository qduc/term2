/**
 * The direct conversation owns the engine reader and the durable writer. An
 * engine envelope is accepted only after its fact has committed. Public events
 * contain no acceptance capability; answers likewise commit before release.
 * Cancellation/consumer return retains turn ownership through physical cleanup.
 */
import { startTurn } from '../engine/index.js';
import type {
  AcceptedTurnEvent,
  InteractionDecision,
  InteractionRequest,
  InteractionRequestId,
  TurnEvent,
  TurnHandle,
  TurnId,
  TurnResult,
} from '../engine/index.js';
import type { Item, ModelError } from '../model/index.js';
import type { AnswerResult, Conversation, ConversationDeps, Turn } from './direct-types.js';
import type { Fact, SessionStartedFact } from './facts.js';
import { replay } from './replay.js';

export type { AnswerResult, Conversation, ConversationDeps, Turn, TurnRequest } from './direct-types.js';

/** Writes session_started before any engine can be constructed. */
export function createConversation(
  deps: ConversationDeps & { readonly meta: Omit<SessionStartedFact, 'type'> },
): Conversation {
  const started: Fact = { type: 'session_started', ...deps.meta };
  deps.log.append([started]);
  return conversation(deps, deps.meta.id, [started]);
}

/** Opening is read-only; recovery is materialized with the next turn's input. */
export function openConversation(deps: ConversationDeps & { readonly facts: readonly Fact[] }): Conversation {
  const started = deps.facts.find((fact) => fact.type === 'session_started');
  if (!started) throw new Error(`${deps.log.path} has no session_started fact`);
  // Reject inconsistent histories before a later run can write to them.
  replay(deps.facts);
  return conversation(deps, started.id, [...deps.facts]);
}

function conversation(deps: ConversationDeps, id: string, facts: Fact[]): Conversation {
  let active: { stop(): Promise<void> } | null = null;
  let closed = false;
  let logFailure: ModelError | null = null;

  // A short write may leave a torn line. A poisoned writer is never retried.
  const commit = (next: readonly Fact[]): boolean => {
    if (logFailure) return false;
    if (next.length === 0) return true;
    try {
      deps.log.append(next);
      facts.push(...next);
      return true;
    } catch (error) {
      logFailure = modelError(error);
      return false;
    }
  };

  function ownTurn(turnId: TurnId, handle: TurnHandle): Turn & { stop(): Promise<void> } {
    const requests = new Map<InteractionRequestId, InteractionRequest>();
    const engine = handle.events[Symbol.asyncIterator]();
    let cancelled = false;
    let started = false;
    let done = false;
    let released = false;
    let terminal: TurnResult | null = null;
    let streamFailure: ModelError | null = null;

    const closeInteractions = (): void => {
      const closures: Fact[] = [...requests.keys()].map((requestId) => ({
        type: 'interaction_closed',
        turnId,
        requestId,
        resolution: { kind: 'cancelled' },
      }));
      requests.clear();
      commit(closures);
    };
    const cancel = (): void => {
      if (released || cancelled) return;
      cancelled = true;
      closeInteractions();
      handle.cancel();
    };
    const settle = (result: TurnResult): void => {
      if (terminal) return;
      closeInteractions();
      const outcome = streamFailure
        ? { kind: 'failed' as const, error: streamFailure }
        : cancelled && result.kind === 'completed'
        ? { kind: 'cancelled' as const }
        : result;
      if (!logFailure) {
        // The same deterministic repair used on reopen supplies missing root
        // results. Its interrupted terminal is replaced by the actual outcome.
        const repairs = replay(facts).recoveryFacts.filter((fact) => fact.type !== 'turn_ended');
        commit([...repairs, terminalFact(turnId, outcome)]);
      }
      terminal = logFailure ? { kind: 'failed', error: logFailure } : outcome;
    };
    const consume = ({ token, event }: AcceptedTurnEvent, draining: boolean): TurnEvent | null => {
      if (event.type === 'turn_ended') {
        settle(event.result);
        if (logFailure) handle.cancel();
        else handle.accept(token);
        return null;
      }
      if (terminal || logFailure) return null;
      // Cleanup outcomes still matter, but late text/progress and unadmitted
      // starts must not become visible or authorize work after cancellation.
      const cleanup =
        event.type === 'tool_execution_finished' || (event.type === 'item' && event.item.type === 'tool_result');
      if ((cancelled || draining) && !cleanup) return null;
      const fact = factFor(turnId, event);
      if (fact && !commit([fact])) {
        cancel();
        return null;
      }
      if (event.type === 'interaction_required') requests.set(event.request.requestId, event.request);
      handle.accept(token);
      return cancelled || draining ? null : event;
    };
    const drain = async (): Promise<void> => {
      while (!done) {
        try {
          const next = await engine.next();
          done = next.done === true;
          if (!next.done) consume(next.value, true);
        } catch (error) {
          done = true;
          streamFailure ??= modelError(error);
        }
      }
      if (!terminal) settle(streamFailure ? { kind: 'failed', error: streamFailure } : lostTerminal);
    };

    async function* drive(): AsyncGenerator<TurnEvent, void> {
      started = true;
      try {
        while (!done) {
          const next = await engine.next();
          done = next.done === true;
          if (next.done) break;
          const event = consume(next.value, false);
          if (event) yield event;
        }
      } catch (error) {
        streamFailure = modelError(error);
      } finally {
        // Do not use for-await's implicit iterator.return: the engine may have
        // outstanding bodies whose finish events must be consumed first.
        if (!done) cancel();
        try {
          await drain();
        } finally {
          released = true;
          active = null;
        }
      }
      yield { type: 'turn_ended', result: terminal! };
    }
    const stream = drive();
    const stop = async (): Promise<void> => {
      cancel();
      // Returning a never-started async generator skips its finally block.
      // Start it under cancellation so the same reader drains in that case too.
      if (!started) await stream.next();
      await stream.return();
    };

    return {
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: () => stream.next(),
            return: async () => {
              await stop();
              return { done: true as const, value: undefined };
            },
          };
        },
      },
      cancel,
      stop,
      answer(requestId, decision): AnswerResult {
        const request = requests.get(requestId);
        if (released || cancelled || terminal || !request) return { kind: 'stale' };
        if (!validDecision(request, decision))
          return { kind: 'failed', error: modelError('invalid interaction decision') };
        if (!commit([{ type: 'interaction_closed', turnId, requestId, resolution: decision }])) {
          cancel();
          return { kind: 'failed', error: logFailure! };
        }
        requests.delete(requestId);
        // Stop-after-resolution is durable but must not release an allowed body.
        if (decision.stopAfterApprovalResolution) cancel();
        handle.answer(requestId, decision);
        return { kind: 'accepted' };
      },
    };
  }

  return {
    id,
    run(request) {
      if (closed) throw new Error(`conversation ${id} is closed`);
      if (active) throw new Error(`conversation ${id} already has an active turn`);
      if (logFailure) return failedTurn(logFailure);
      if (
        request.submission &&
        (!request.submission.clientRequestId ||
          !request.input.some((item) => item.type === 'user_message' && item.id === request.submission!.messageId))
      ) {
        throw new Error('submission must identify a nonempty request ID and one admitted user item');
      }
      const { history, nextTurn, recoveryFacts } = replay(facts);
      const turnId = `turn-${nextTurn}` as TurnId;
      if (
        !commit([
          ...recoveryFacts,
          {
            type: 'turn_started',
            turnId,
            input: request.input,
            ...(request.submission ? { submission: request.submission } : {}),
          },
        ])
      )
        return failedTurn(logFailure!);
      const { input, notice, submission: _submission, ...settings } = request;
      try {
        const handle = startTurn(
          { ...settings, turnId, history, newItems: notice ? withNotice(input, notice) : input },
          deps,
        );
        const turn = ownTurn(turnId, handle);
        active = turn;
        return turn;
      } catch (error) {
        const failure = modelError(error);
        commit([terminalFact(turnId, { kind: 'failed', error: failure })]);
        return failedTurn(logFailure ?? failure);
      }
    },
    async close() {
      closed = true;
      // Closing a client is not this operation: only the runtime owner closes
      // the conversation, and it waits for cleanup before releasing the writer.
      try {
        await active?.stop();
      } finally {
        deps.log.close();
      }
    },
  };
}

const lostTerminal: TurnResult = {
  kind: 'failed',
  error: { kind: 'provider', message: 'turn ended without a terminal event', retryable: false },
};

function modelError(error: unknown): ModelError {
  return { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryable: false };
}

function validDecision(request: InteractionRequest, decision: InteractionDecision): boolean {
  if (!decision || typeof decision !== 'object') return false;
  if (decision.stopAfterApprovalResolution !== undefined && typeof decision.stopAfterApprovalResolution !== 'boolean')
    return false;
  if (request.kind === 'question') return decision.kind === 'answer' && typeof decision.answer === 'string';
  return (
    decision.kind === 'allow' ||
    (decision.kind === 'deny' && (decision.reason === undefined || typeof decision.reason === 'string'))
  );
}

function failedTurn(error: ModelError): Turn {
  return {
    events: (async function* () {
      yield { type: 'turn_ended', result: { kind: 'failed', error } } as const;
    })(),
    cancel() {},
    answer: () => ({ kind: 'stale' }),
  };
}

/** Reasoning/progress/attempt notices stay transient; authority-bearing facts fsync. */
function factFor(turnId: TurnId, event: Exclude<TurnEvent, { type: 'turn_ended' }>): Fact | null {
  switch (event.type) {
    case 'text_delta':
      return {
        type: 'text_delta',
        turnId,
        delta: event.delta,
        ...(event.modelStep !== undefined ? { modelStep: event.modelStep } : {}),
      };
    case 'item':
      return {
        type: 'item',
        turnId,
        item: event.item,
        ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
        ...(event.modelStep !== undefined ? { modelStep: event.modelStep } : {}),
      };
    case 'usage':
      return {
        type: 'usage',
        turnId,
        usage: event.usage,
        ...(event.modelStep !== undefined ? { modelStep: event.modelStep } : {}),
      };
    case 'tool_start_requested':
      return {
        type: 'tool_started',
        turnId,
        executionId: event.executionId,
        callId: event.callId,
        toolName: event.toolName,
        input: event.input,
        ...(event.parentExecutionId !== undefined ? { parentExecutionId: event.parentExecutionId } : {}),
      };
    case 'tool_execution_finished':
      return { type: 'tool_finished', turnId, executionId: event.executionId, result: event.result };
    case 'interaction_required':
      return { type: 'interaction_opened', turnId, request: event.request };
    default:
      return null;
  }
}

function terminalFact(turnId: TurnId, result: TurnResult): Fact {
  return {
    type: 'turn_ended',
    turnId,
    outcome: result.kind,
    ...(result.kind === 'failed' ? { error: result.error } : {}),
  };
}

/** Notice is request-only: durable user history retains the user's exact input. */
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
