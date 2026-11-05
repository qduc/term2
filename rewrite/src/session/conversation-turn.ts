/** The sole reader of an engine handle: durable acceptance, human answers and physical cleanup. */
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
import type { Fact, DirectTurnFact, DirectHistoryFact } from './facts.js';
import type { Turn, TurnRequest, AnswerResult, AnswerProvenance, ConversationDeps } from './direct-types.js';
import type { bindDirectCapabilities } from './direct-capabilities.js';
import { ConversationJournal, modelError } from './conversation-journal.js';
import { isDirectHumanOrigin } from './direct-origin.js';
import { directPreviewConfiguration } from './direct-preview.js';
import { planDirectTiming } from './direct-time-gap.js';

/** Accept raw admission and memory facts before engine construction; timing is model-only. */
export function admitConversationTurn(
  turnId: TurnId,
  request: TurnRequest,
  planned: { readonly accepted?: true; readonly silent?: true; readonly facts: readonly Fact[] } | undefined,
  journal: ConversationJournal,
  capabilities: ReturnType<typeof bindDirectCapabilities>,
  requestNotice?: string,
): readonly Item[] {
  const isHuman = !planned?.accepted && !planned?.silent && isDirectHumanOrigin(request.submission?.origin);
  // Plan only the actual human input. Personal-memory user-shaped notices are
  // automatic context and must not be mistaken for a missing human receipt.
  const timingInput = isHuman
    ? planDirectTiming(
        journal.context.latestHumanInputAt,
        [
          ...journal.queueState.records,
          ...(planned?.facts ?? []).flatMap((fact) => (fact.type === 'queue_submitted' ? [fact.record] : [])),
        ],
        request.input,
      ).modelInput
    : request.input;
  const human = isHuman
    ? capabilities.humanPlan(request.submission?.messageId ?? turnId, timingInput)
    : { facts: capabilities.memoryFacts(), modelInput: timingInput };
  if (
    !planned?.accepted &&
    !journal.commit([
      ...(planned?.facts ?? []),
      ...human.facts,
      {
        type: 'turn_started',
        ...(planned?.silent ? { silent: true as const } : {}),
        turnId,
        input: request.input,
        ...(requestNotice ? { requestNotice } : {}),
        ...(directPreviewConfiguration(request) ? { requestConfiguration: directPreviewConfiguration(request) } : {}),
        ...(request.submission ? { submission: request.submission } : {}),
      },
    ])
  )
    throw new Error(journal.failure!.message);
  return human.modelInput;
}

export type OwnedConversationTurn = Turn & {
  readonly turnId: TurnId;
  readonly cancelled: boolean;
  stop(): Promise<void>;
  steer(): void;
};

/** Owns the handle until cleanup settles, including when its consumer returns early. */
export function ownConversationTurn(
  turnId: TurnId,
  handle: TurnHandle,
  journal: ConversationJournal,
  options: {
    readonly capabilities: ReturnType<typeof bindDirectCapabilities>;
    readonly publishNotice: ConversationDeps['publishNotice'];
    released(): void;
  },
): OwnedConversationTurn {
  const requests = new Map<InteractionRequestId, InteractionRequest>();
  const budgets = new Map<InteractionRequestId, Extract<TurnEvent, { type: 'budget_required' }>>();
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
    for (const requestId of budgets.keys())
      closures.push({ type: 'budget_closed', turnId, requestId, decision: { kind: 'stop' }, source: 'system' });
    budgets.clear();
    journal.commit(closures);
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
    if (!journal.failure) {
      // Live settlement knows the handle has drained, unlike crash recovery.
      // Preserve known outcomes and distinguish unadmitted calls from possible effects.
      const repairs = journal.settledReplay().recoveryFacts.filter((fact) => fact.type !== 'turn_ended');
      const ended = terminalFact(turnId, outcome);
      journal.commit([...repairs, ended]);
    }
    terminal = journal.failure ? { kind: 'failed', error: journal.failure } : outcome;
  };
  const consume = ({ token, event }: AcceptedTurnEvent, draining: boolean): TurnEvent | null => {
    if (event.type === 'turn_ended') {
      settle(event.result);
      if (journal.failure) handle.cancel();
      else handle.accept(token);
      return null;
    }
    if (terminal || journal.failure) return null;
    // Cleanup outcomes still matter, but late text/progress and unadmitted
    // starts must not become visible or authorize work after cancellation.
    const cleanup =
      event.type === 'tool_execution_finished' ||
      event.type === 'compaction_completed' ||
      event.type === 'compaction_failed' ||
      (event.type === 'item' && event.item.type === 'tool_result');
    if ((cancelled || draining) && !cleanup) return null;
    const fact = factFor(turnId, event);
    if (fact && !journal.commit([fact])) {
      cancel();
      return null;
    }
    if (event.type === 'budget_required') budgets.set(event.requestId, event);
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
        if (!cancelled && !journal.failure && options.capabilities?.finalizeHuman) {
          const admission = journal.facts.find((fact) => fact.type === 'turn_started' && fact.turnId === turnId);
          if (
            admission?.type === 'turn_started' &&
            !admission.silent &&
            !admission.maintenance &&
            !admission.retryContext &&
            isDirectHumanOrigin(admission.submission?.origin)
          ) {
            const content = admission.input.flatMap((item) => (item.type === 'user_message' ? [...item.content] : []));
            const notice = await options.capabilities.finalizeHuman({
              admissionId: admission.submission?.messageId ?? turnId,
              text: content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
              images: content.filter((part) => part.type === 'image'),
            });
            if (notice) options.publishNotice?.(notice);
          }
        }
      } finally {
        released = true;
        options.released();
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
    turnId,
    steer: () => handle.steer(),
    get cancelled() {
      return cancelled;
    },
    cancel,
    stop,
    answerBudget(requestId, decision, provenance = { source: 'system' }): AnswerResult {
      if (released || cancelled || terminal || !budgets.has(requestId)) return { kind: 'stale' };
      if (decision.kind === 'extend' && (decision.grantedBy !== 'human' || provenance.source !== 'user'))
        return { kind: 'failed', error: modelError('Budget extension requires an explicit human answer') };
      if (decision.kind === 'steer')
        return { kind: 'failed', error: modelError('Use durable queued steering before resuming a budget wait') };
      if (
        !journal.commit([
          {
            type: 'budget_closed',
            turnId,
            requestId,
            decision,
            source: provenance.source === 'user' ? 'user' : 'system',
          },
        ])
      ) {
        cancel();
        return { kind: 'failed', error: journal.failure! };
      }
      budgets.delete(requestId);
      handle.answerBudget(requestId, decision);
      return { kind: 'accepted' };
    },
    answer(requestId, decision, provenance: AnswerProvenance = { source: 'system' }): AnswerResult {
      const request = requests.get(requestId);
      if (released || cancelled || terminal || !request) return { kind: 'stale' };
      if (!validDecision(request, decision))
        return { kind: 'failed', error: modelError('invalid interaction decision') };
      if (
        !journal.commit([
          {
            type: 'interaction_closed',
            turnId,
            requestId,
            resolution: decision,
            resolutionSource: provenance.source,
            ...(provenance.automaticApproval !== undefined ? { automaticApproval: provenance.automaticApproval } : {}),
          },
        ])
      ) {
        cancel();
        return { kind: 'failed', error: journal.failure! };
      }
      requests.delete(requestId);
      // Stop is continuation control, not cancellation: the selected allowed
      // body (or unanswered question result) must settle first. The engine
      // suppresses later bodies/model steps while retaining cleanup ownership.
      handle.answer(requestId, decision);
      return { kind: 'accepted' };
    },
  };
}

const lostTerminal: TurnResult = {
  kind: 'failed',
  error: { kind: 'provider', message: 'turn ended without a terminal event', retryable: false },
};

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

export function failedTurn(error: ModelError): Turn {
  return {
    events: (async function* () {
      yield { type: 'turn_ended', result: { kind: 'failed', error } } as const;
    })(),
    cancel() {},
    answer: () => ({ kind: 'stale' }),
    answerBudget: () => ({ kind: 'stale' }),
  };
}

/** Reasoning/progress/attempt notices stay transient; authority-bearing facts fsync. */
export function factFor(
  turnId: TurnId,
  event: Exclude<TurnEvent, { type: 'turn_ended' }>,
): DirectTurnFact | DirectHistoryFact | null {
  switch (event.type) {
    case 'text_delta':
      return {
        type: 'text_delta',
        turnId,
        delta: event.delta,
        ...(event.modelStep !== undefined ? { modelStep: event.modelStep } : {}),
        ...(event.withdrawn ? { withdrawn: true as const } : {}),
      };
    case 'item':
      return {
        type: 'item',
        turnId,
        item: event.item,
        ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
        ...(event.modelStep !== undefined ? { modelStep: event.modelStep } : {}),
      };
    case 'budget_required':
      return { ...event, type: 'budget_opened' };
    case 'budget_observed':
      return { ...event, turnId };
    case 'compaction_started':
    case 'compaction_completed':
    case 'compaction_failed':
    case 'model_response_completed':
      return { ...event, turnId };
    case 'history_replaced':
      return { ...event, turnId };
    case 'usage':
      return {
        type: 'usage',
        turnId,
        usage: event.usage,
        ...(event.speed ? { speed: event.speed } : {}),
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

export function terminalFact(turnId: TurnId, result: TurnResult): Extract<Fact, { type: 'turn_ended' }> {
  return {
    type: 'turn_ended',
    turnId,
    outcome: result.kind,
    ...(result.kind === 'failed' ? { error: result.error } : {}),
    ...('terminalCause' in result && result.terminalCause ? { terminalCause: result.terminalCause } : {}),
    ...('notice' in result && result.notice ? { notice: result.notice } : {}),
  };
}
