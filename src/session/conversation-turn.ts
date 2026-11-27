/** The sole reader of an engine handle: durable acceptance, human answers and physical cleanup. */
import { runTerminationCause } from '../shared/contracts/run-termination.js';
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
import type { ModelRequestCost } from './recovery-budget.js';
import type { Item, ModelError } from '../model/index.js';
import type { Fact, DirectTurnFact, DirectHistoryFact, DirectRequestCostFact } from './facts.js';
import type { Turn, TurnRequest, AnswerResult, AnswerProvenance, ConversationDeps } from './types.js';
import type { bindDirectCapabilities } from './capabilities.js';
import { ConversationJournal, modelError } from './conversation-journal.js';
import { isDirectHumanOrigin } from './origin.js';
import { directPreviewConfiguration } from './preview.js';
import { planDirectTiming } from './time-gap.js';
import { effortFallbackNotice } from './effort-timeline.js';
import { isEffortUpdateItem } from '../model/effort-updates.js';
import { resolveApprovalDecision, REVIEW_STOPPED, type ApprovalReviews } from './approval/approval-arbiter.js';
import type { ApprovalReviewResult } from '../shared/contracts/approval-review.js';
import { UnattendedRefusals, withUnattendedReport } from './approval/unattended-refusals.js';
import { terminalNotice } from './harness-host/index.js';

/** Accept raw admission and memory facts before engine construction; timing is model-only. */
export function admitConversationTurn(
  turnId: TurnId,
  request: TurnRequest,
  planned: { readonly accepted?: true; readonly silent?: true; readonly facts: readonly Fact[] } | undefined,
  journal: ConversationJournal,
  capabilities: ReturnType<typeof bindDirectCapabilities>,
  requestNotice?: string,
  persistentNotice?: string,
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
        ...(persistentNotice ? { persistentNotice } : {}),
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
    /** Builds (never writes) the cost fact for this turn's `request_cost` event; see `DirectRunBudgets.costFact`. */
    readonly requestCost: (record: ModelRequestCost) => DirectRequestCostFact;
    readonly capabilities: ReturnType<typeof bindDirectCapabilities>;
    readonly publishNotice: ConversationDeps['publishNotice'];
    /** Reviews a request before it opens (src/session/approval/approval-arbiter.ts). */
    readonly reviews?: ApprovalReviews;
    /** Unattended: the turn's workspace snapshot report for its terminal notice (bounded, synchronous). */
    readonly snapshotReport?: () => string | undefined;
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
  // Unattended approval: this turn's refusals and the limit that ends it (approval/unattended-refusals.ts).
  const refusals = new UnattendedRefusals();
  const refusedExecutions = new Set<string>();

  const closeInteractions = (): void => {
    // A request still under review never opened, so it has nothing to close.
    const opened = [...requests.keys()].filter((requestId) => options.reviews?.stop(requestId) === undefined);
    const closures: Fact[] = opened.map((requestId) => ({
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
      const ended = withFallbackNotice(
        withUnattendedReport(terminalFact(turnId, outcome), refusals, options.snapshotReport?.()),
        effortFallbackNotice(journal.facts, turnId),
      );
      journal.commit([...repairs, ended]);
    }
    terminal = journal.failure ? { kind: 'failed', error: journal.failure } : outcome;
  };
  const openFact = (request: InteractionRequest, review?: ApprovalReviewResult): Fact => ({
    type: 'interaction_opened',
    turnId,
    request,
    ...(review ? { review } : {}),
  });
  /** Open a reviewed or headless-policy request: a policy close when settled automatically, else wait for a person. */
  function settleReview(
    request: InteractionRequest,
    review: ApprovalReviewResult | undefined,
    policyDecision?: InteractionDecision,
  ): void {
    if (released || cancelled || terminal || !requests.has(request.requestId)) return;
    const { automatic, decision, recordedReview } = resolveApprovalDecision(
      request,
      review,
      policyDecision,
      validDecision,
    );
    if (!decision && options.reviews?.unattended()) {
      const refused = refuse(request, {
        ...(review ?? { kind: 'not_reviewed' }),
        approved: false,
      } as ApprovalReviewResult);
      if (refused) handle.answer(request.requestId, refused);
      return;
    }
    const facts: Fact[] = [openFact(request, recordedReview)];
    if (decision)
      facts.push({
        type: 'interaction_closed',
        turnId,
        requestId: request.requestId,
        resolution: decision,
        resolutionSource: 'policy',
        ...(automatic ? { automaticApproval: true } : {}),
      });
    let committed = false;
    try {
      committed = journal.commit(facts);
    } catch {
      committed = false;
    }
    if (!committed) {
      cancel();
      return;
    }
    if (!decision) return;
    requests.delete(request.requestId);
    handle.answer(request.requestId, decision);
  }
  /**
   * Unattended: open the request with its review and close it by policy with a refusal the model reads.
   * At the refusal limit the denial stops the turn: no further model request follows.
   */
  function refuse(
    request: InteractionRequest,
    review: ApprovalReviewResult,
    unreviewed?: string,
  ): InteractionDecision | undefined {
    if (released || cancelled || terminal || !requests.has(request.requestId)) return undefined;
    const refused = refusals.refuse(request, review, unreviewed);
    const decision: InteractionDecision = refused.denial;
    let committed = false;
    try {
      committed = journal.commit([
        openFact(request, refused.review),
        {
          type: 'interaction_closed',
          turnId,
          requestId: request.requestId,
          resolution: decision,
          resolutionSource: 'policy',
        },
      ]);
    } catch {
      committed = false;
    }
    if (!committed) {
      cancel();
      return undefined;
    }
    // A nested (run_code) refusal names its parent: that parent finishing is not a result that resets the count.
    for (const id of [request.executionId, request.parentExecutionId]) if (id) refusedExecutions.add(id);
    requests.delete(request.requestId);
    return decision;
  }
  const refuseLater = (request: InteractionRequest, review: ApprovalReviewResult): void => {
    const decision = refuse(request, review);
    if (decision) handle.answer(request.requestId, decision);
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
      event.type === 'request_cost' ||
      (event.type === 'item' && event.item.type === 'tool_result');
    if ((cancelled || draining) && !cleanup) return null;
    // A reviewable request stays unopened until its review settles or a person steps in.
    if (event.type === 'interaction_required' && !cancelled && !draining && options.reviews) {
      requests.set(event.request.requestId, event.request);
      if (options.reviews.begin(event.request, { settle: settleReview, refuse: refuseLater })) {
        handle.accept(token);
        return null;
      }
      const unreviewed = options.reviews.refusal(event.request);
      if (unreviewed !== undefined) {
        // Refused without a review: no client is asked. The engine admits an answer only after the accept.
        const decision = refuse(event.request, { kind: 'not_reviewed', approved: false }, unreviewed);
        if (decision) {
          handle.accept(token);
          handle.answer(event.request.requestId, decision);
        }
        return null;
      }
      requests.delete(event.request.requestId);
    }
    // Unattended never grants budget or turns: a run check-in is declined, as a person choosing stop would.
    if (event.type === 'budget_required' && !cancelled && !draining && options.reviews?.unattended()) {
      const opened = factFor(turnId, event);
      if (
        !journal.commit([
          ...(opened ? [opened] : []),
          { type: 'budget_closed', turnId, requestId: event.requestId, decision: { kind: 'stop' }, source: 'system' },
        ])
      ) {
        cancel();
        return null;
      }
      handle.accept(token);
      handle.answerBudget(event.requestId, { kind: 'stop' });
      return null;
    }
    if (event.type === 'tool_execution_finished' && !refusedExecutions.has(event.executionId)) refusals.reset();
    // Cost is a fact, never a client event: its views come from the accepted fact.
    const fact = event.type === 'request_cost' ? options.requestCost(event.record) : factFor(turnId, event);
    if (fact && !journal.commit([fact])) {
      cancel();
      return null;
    }
    if (event.type === 'budget_required') budgets.set(event.requestId, event);
    if (event.type === 'interaction_required') requests.set(event.request.requestId, event.request);
    handle.accept(token);
    return cancelled || draining || event.type === 'request_cost' ? null : event;
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
      // Only the arbiter records an automatic approval; a client cannot claim one.
      if (provenance.automaticApproval === true)
        return { kind: 'failed', error: modelError('automatic approval is recorded by the session only') };
      // A person answered while the review ran: it opens and closes with their decision.
      const underReview = options.reviews?.stop(requestId) !== undefined;
      if (
        !journal.commit([
          ...(underReview ? [openFact(request, REVIEW_STOPPED)] : []),
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
    takeOverReview(requestId): AnswerResult {
      const request = requests.get(requestId);
      if (released || cancelled || terminal || !request || options.reviews?.stop(requestId) === undefined)
        return { kind: 'stale' };
      if (!journal.commit([openFact(request, REVIEW_STOPPED)])) {
        cancel();
        return { kind: 'failed', error: journal.failure! };
      }
      return { kind: 'accepted' };
    },
  };
}

const lostTerminal: TurnResult = {
  kind: 'failed',
  error: { kind: 'provider', message: 'turn ended without a terminal event', retryable: false },
};

/** A scoped grant is never a plain allow: it must be one the request itself offered. */
export function grantOffered(
  request: { readonly grants?: readonly string[] },
  decision: { readonly grant?: unknown },
): boolean {
  return (
    decision.grant === undefined || (typeof decision.grant === 'string' && !!request.grants?.includes(decision.grant))
  );
}

function validDecision(request: InteractionRequest, decision: InteractionDecision): boolean {
  if (!decision || typeof decision !== 'object') return false;
  if (decision.stopAfterApprovalResolution !== undefined && typeof decision.stopAfterApprovalResolution !== 'boolean')
    return false;
  if (request.kind === 'question') return decision.kind === 'answer' && typeof decision.answer === 'string';
  return (
    (decision.kind === 'allow' && grantOffered(request, decision)) ||
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
      // Legacy leaves the shown transcript as it was after a compaction; only provider context is replaced.
      // Effort markers are derived per turn (effort-timeline.ts) and never become durable history.
      return {
        ...event,
        history: event.history.filter((item) => !isEffortUpdateItem(item)),
        turnId,
        ...(event.reason === 'compaction' ? { retainTranscript: true as const } : {}),
      };
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

function withFallbackNotice(
  ended: Extract<Fact, { type: 'turn_ended' }>,
  notice: string | undefined,
): Extract<Fact, { type: 'turn_ended' }> {
  return notice ? { ...ended, notice: ended.notice ? `${ended.notice}\n\n${notice}` : notice } : ended;
}

export function terminalFact(turnId: TurnId, result: TurnResult): Extract<Fact, { type: 'turn_ended' }> {
  const terminalCause = 'terminalCause' in result ? runTerminationCause(result.terminalCause) : undefined;
  return {
    type: 'turn_ended',
    turnId,
    outcome: result.kind,
    ...(result.kind === 'failed' ? { error: result.error } : {}),
    ...(terminalCause !== undefined ? { terminalCause } : {}),
    ...('notice' in result && result.notice ? { notice: terminalNotice(result) } : {}),
  };
}
