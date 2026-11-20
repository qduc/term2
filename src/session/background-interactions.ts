import { randomUUID } from 'node:crypto';
import type { ExecutionId, InteractionDecision, InteractionRequestId } from '../tools/index.js';
import type { AnswerProvenance, AnswerResult } from './types.js';
import type {
  DirectBackgroundFact,
  DirectTaskId,
  DirectTaskInteraction,
  DirectTaskInteractionResolution,
} from './background-types.js';
import { directTaskAbortError, directTaskError } from './background-types.js';
import { grantOffered } from './conversation-turn.js';
import { REVIEW_STOPPED, type ApprovalReviews } from './approval/approval-arbiter.js';
import type { ApprovalReviewResult } from '../shared/contracts/approval-review.js';
import { UnattendedRefusals } from './approval/unattended-refusals.js';

type Pending = {
  readonly request: DirectTaskInteraction;
  readonly unattendedOnly: boolean;
  readonly resolve: (decision: InteractionDecision) => void;
  readonly reject: (error: Error) => void;
  detach(): void;
};

/**
 * Live waiters owned by Session, independently of any foreground Turn. It
 * accepts request open/close facts through the Session sink, then releases the
 * exact waiter once. Reopen must recover facts, not rehydrate these promises.
 */
export class DirectBackgroundInteractions {
  readonly #accept: (fact: DirectBackgroundFact) => void;
  readonly #pending = new Map<InteractionRequestId, Pending>();
  readonly #used = new Set<InteractionRequestId>();
  #reviews: ApprovalReviews | undefined;
  /** Unattended refusals per background task (approval/unattended-refusals.ts). */
  readonly #refusals = new Map<
    DirectTaskId,
    { readonly counter: UnattendedRefusals; readonly executions: Set<ExecutionId> }
  >();

  constructor(accept: (fact: DirectBackgroundFact) => void) {
    this.#accept = accept;
  }

  /** Review requests before they open (src/session/approval/approval-arbiter.ts). */
  useReviews(reviews: ApprovalReviews): void {
    this.#reviews = reviews;
  }

  /** A completed execution breaks the streak unless it or a call it contains was refused. */
  toolFinished(taskId: DirectTaskId, executionId: ExecutionId): void {
    const state = this.#refusals.get(taskId);
    if (state && !state.executions.delete(executionId)) state.counter.reset();
  }

  refusalLimitReport(taskId: DirectTaskId): string | undefined {
    const counter = this.#refusals.get(taskId)?.counter;
    return counter?.limited ? counter.report() : undefined;
  }

  /** A continued task has a new run and a fresh refusal limit. */
  releaseRefusals(taskId: DirectTaskId): void {
    this.#refusals.delete(taskId);
  }

  /** Stop a review so a person decides; stale when the request is not under review. */
  takeOverReview(requestId: InteractionRequestId): AnswerResult {
    const entry = this.#pending.get(requestId);
    if (!entry || entry.unattendedOnly || this.#reviews?.stop(requestId) === undefined) return { kind: 'stale' };
    try {
      this.#accept({ type: 'task_interaction_opened', request: entry.request, review: REVIEW_STOPPED });
    } catch (error) {
      return { kind: 'failed', error: directTaskError(error) };
    }
    return { kind: 'accepted' };
  }

  #settleReview(entry: Pending, review: ApprovalReviewResult): void {
    if (this.#pending.get(entry.request.requestId) !== entry) return;
    if (entry.unattendedOnly && !this.#reviews?.unattended()) {
      this.#remove(entry);
      entry.reject(new Error('Background task cannot wait for approval.'));
      return;
    }
    const decision: InteractionDecision | undefined = review.approved
      ? review.grant
        ? { kind: 'allow', grant: review.grant }
        : { kind: 'allow' }
      : undefined;
    const automatic = decision && validDecision(entry.request, decision) ? decision : undefined;
    // Unattended never opens an approval for a person, even when an approval cannot be applied.
    if (!automatic && this.#reviews?.unattended())
      return this.#refuse(entry, { ...review, approved: false } as ApprovalReviewResult);
    try {
      this.#accept({
        type: 'task_interaction_opened',
        request: entry.request,
        review: automatic ? review : ({ ...review, approved: false } as ApprovalReviewResult),
      });
      if (!automatic) return;
      this.#accept({
        type: 'task_interaction_closed',
        taskId: entry.request.taskId,
        requestId: entry.request.requestId,
        resolution: { kind: 'decision', decision: automatic },
        resolutionSource: 'policy',
        automaticApproval: true,
      });
    } catch (error) {
      this.poison(new Error(directTaskError(error).message));
      return;
    }
    this.#remove(entry);
    entry.resolve(automatic);
  }

  /**
   * Unattended: open with the review and close by policy with a refusal the task's model reads. At the
   * limit the denial stops the task's run and carries the list of the task's refusals.
   */
  #refuse(entry: Pending, review: ApprovalReviewResult, unreviewed?: string): void {
    if (this.#pending.get(entry.request.requestId) !== entry) return;
    const taskId = entry.request.taskId;
    const state = this.#refusals.get(taskId) ?? {
      counter: new UnattendedRefusals(),
      executions: new Set<ExecutionId>(),
    };
    const refused = state.counter.refuse(entry.request, review, unreviewed, true);
    const decision: InteractionDecision = refused.denial;
    try {
      this.#accept({ type: 'task_interaction_opened', request: entry.request, review: refused.review });
      this.#accept({
        type: 'task_interaction_closed',
        taskId,
        requestId: entry.request.requestId,
        resolution: { kind: 'decision', decision },
        resolutionSource: 'policy',
      });
    } catch (error) {
      this.poison(new Error(directTaskError(error).message));
      return;
    }
    for (const id of [entry.request.executionId, entry.request.parentExecutionId]) if (id) state.executions.add(id);
    this.#refusals.set(taskId, state);
    this.#remove(entry);
    entry.resolve(decision);
  }

  /** Allocate a globally unique ID for tool pauses without an engine-supplied ID. */
  createId(): InteractionRequestId {
    return randomUUID() as InteractionRequestId;
  }

  /** Returns immutable presentation data, never live continuations. */
  pending(taskId?: DirectTaskId): readonly DirectTaskInteraction[] {
    return (
      [...this.#pending.values()]
        .filter((entry) => taskId === undefined || entry.request.taskId === taskId)
        // Under review is not yet waiting on a person. A worker's unattended approval never does.
        .filter((entry) => !entry.unattendedOnly && !this.#reviews?.has(entry.request.requestId))
        .map((entry) => structuredClone(entry.request))
    );
  }

  /** Open one exact occurrence, and wait without blocking other tasks or turns. */
  open(request: DirectTaskInteraction, signal: AbortSignal, unattendedOnly = false): Promise<InteractionDecision> {
    if (signal.aborted) return Promise.reject(directTaskAbortError());
    if (unattendedOnly && (request.kind !== 'approval' || !this.#reviews?.unattended()))
      return Promise.reject(new Error('Background task cannot wait for approval.'));
    if (this.#used.has(request.requestId)) return Promise.reject(new Error('Interaction request ID already used.'));
    const acceptedRequest = structuredClone(request);
    this.#used.add(request.requestId);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        try {
          this.cancelTask(request.taskId);
        } catch (error) {
          this.poison(new Error(directTaskError(error).message));
        }
      };
      const entry: Pending = {
        request: acceptedRequest,
        unattendedOnly,
        resolve,
        reject,
        detach: () => signal.removeEventListener('abort', onAbort),
      };
      this.#pending.set(request.requestId, entry);
      try {
        // A reviewable request stays unopened until its review settles or a person steps in.
        const reviewing =
          acceptedRequest.kind === 'approval' &&
          this.#reviews?.begin(acceptedRequest, {
            settle: (_request, review) => this.#settleReview(entry, review),
            refuse: (_request, review) => this.#refuse(entry, review),
          });
        const unreviewed =
          !reviewing && acceptedRequest.kind === 'approval' ? this.#reviews?.refusal(acceptedRequest) : undefined;
        if (unreviewed !== undefined || (!reviewing && unattendedOnly))
          this.#refuse(entry, { kind: 'not_reviewed', approved: false }, unreviewed ?? 'the approval route declined');
        else if (!reviewing) this.#accept({ type: 'task_interaction_opened', request: acceptedRequest });
        if (this.#pending.get(request.requestId) !== entry) return;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      } catch (error) {
        this.#remove(entry);
        reject(error);
      }
    });
  }

  /** Persist the supported decision before resuming; stale IDs never select a sibling. */
  answer(
    requestId: InteractionRequestId,
    decision: InteractionDecision,
    provenance: AnswerProvenance = { source: 'system' },
  ): AnswerResult {
    const entry = this.#pending.get(requestId);
    if (!entry || entry.unattendedOnly) return { kind: 'stale' };
    if (!validDecision(entry.request, decision)) {
      return {
        kind: 'failed',
        error: {
          kind: 'invalid_request',
          message: 'Unsupported decision for this task interaction.',
          retryable: false,
        },
      };
    }
    // Only the arbiter records an automatic approval; a client cannot claim one.
    if (provenance.automaticApproval === true)
      return {
        kind: 'failed',
        error: {
          kind: 'invalid_request',
          message: 'Automatic approval is recorded by the session only.',
          retryable: false,
        },
      };
    const acceptedDecision = structuredClone(decision);
    try {
      // A person answered while the review ran: it opens and closes with their decision.
      if (this.#reviews?.stop(requestId) !== undefined)
        this.#accept({ type: 'task_interaction_opened', request: entry.request, review: REVIEW_STOPPED });
      this.#accept({
        type: 'task_interaction_closed',
        taskId: entry.request.taskId,
        requestId,
        resolution: { kind: 'decision', decision: acceptedDecision },
        resolutionSource: provenance.source,
        ...(provenance.automaticApproval !== undefined ? { automaticApproval: provenance.automaticApproval } : {}),
      });
    } catch (error) {
      // The owner poisons the writer; never release the decision on append failure.
      return { kind: 'failed', error: directTaskError(error) };
    }
    this.#remove(entry);
    entry.resolve(acceptedDecision);
    return { kind: 'accepted' };
  }

  /** Close invalidated pauses before rejecting them; no allow is fabricated. */
  cancelTask(taskId: DirectTaskId, kind: 'cancelled' | 'interrupted' = 'cancelled'): void {
    for (const entry of [...this.#pending.values()]) {
      if (entry.request.taskId !== taskId) continue;
      this.#close(entry, { kind });
    }
  }

  /** Writer failure: reject all waits without attempting compensating appends. */
  poison(error: Error): void {
    for (const entry of [...this.#pending.values()]) {
      this.#remove(entry);
      entry.reject(error);
    }
  }

  #close(entry: Pending, resolution: DirectTaskInteractionResolution): void {
    // A request still under review never opened, so it has nothing to close.
    if (this.#reviews?.stop(entry.request.requestId) !== undefined) {
      this.#remove(entry);
      entry.reject(directTaskAbortError());
      return;
    }
    try {
      this.#accept({
        type: 'task_interaction_closed',
        taskId: entry.request.taskId,
        requestId: entry.request.requestId,
        resolution,
      });
    } finally {
      this.#remove(entry);
      entry.reject(directTaskAbortError());
    }
  }

  #remove(entry: Pending): void {
    this.#pending.delete(entry.request.requestId);
    entry.detach();
  }
}

function validDecision(request: DirectTaskInteraction, decision: InteractionDecision): boolean {
  if (decision.stopAfterApprovalResolution !== undefined && typeof decision.stopAfterApprovalResolution !== 'boolean')
    return false;
  if (decision.kind === 'deny' && decision.reason !== undefined && typeof decision.reason !== 'string') return false;
  if (request.kind === 'approval')
    return (decision.kind === 'allow' && grantOffered(request, decision)) || decision.kind === 'deny';
  return (
    (decision.kind === 'answer' && typeof decision.answer === 'string') ||
    (decision.kind === 'deny' && decision.stopAfterApprovalResolution === true)
  );
}
