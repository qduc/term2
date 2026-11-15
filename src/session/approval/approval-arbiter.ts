import type { InteractionRequest, InteractionRequestId } from '../../engine/index.js';
import type { Item } from '../../model/index.js';
import type { ApprovalReviewResult } from '../../shared/contracts/approval-review.js';
import type { DirectTaskId, DirectTaskInteraction } from '../background-types.js';

/**
 * The app-supplied reviewer. `willReview` is the synchronous route (the shared
 * decision table with the live mode); `review` performs the model call and
 * returns the judged result, including the grant an approval answers with.
 * Both read the session's current tool generation, so a rebuild between open
 * and settle is honoured.
 */
export type ApprovalReviewPort = {
  willReview(request: InteractionRequest | DirectTaskInteraction): boolean;
  review(
    request: InteractionRequest | DirectTaskInteraction,
    history: readonly Item[],
    signal: AbortSignal,
  ): Promise<ApprovalReviewResult>;
};

/** Live-only: a request is being reviewed before anyone is asked. Never a fact. */
export type DirectApprovalReviewTransient = {
  readonly type: 'approval_review';
  readonly phase: 'started' | 'settled';
  readonly requestId: InteractionRequestId;
  readonly toolName: string;
  readonly summary: string;
  readonly turnId?: string;
  readonly taskId?: DirectTaskId;
};

type Owner = {
  /** Commit the open (and, when approved, the close) and release the waiter. */
  settle(request: InteractionRequest | DirectTaskInteraction, review: ApprovalReviewResult): void;
};

/**
 * Holds requests under review for one owner (a foreground turn or the
 * background interactions). A request under review is not yet open: nothing is
 * durable, so a process that dies here reopens the turn as interrupted with the
 * call unanswered, like any other unfinished call. The first of review result,
 * person's answer, take-over, or cancellation wins; the rest find nothing.
 */
export class ApprovalReviews {
  readonly #reviews = new Map<
    InteractionRequestId,
    { readonly request: InteractionRequest | DirectTaskInteraction; readonly controller: AbortController }
  >();

  constructor(
    private readonly port: ApprovalReviewPort | undefined,
    private readonly history: () => readonly Item[],
    private readonly publish: ((event: DirectApprovalReviewTransient) => void) | undefined,
  ) {}

  /** Start a review when the route says so; false means the owner opens the request now. */
  begin(request: InteractionRequest | DirectTaskInteraction, owner: Owner): boolean {
    let route = false;
    try {
      route = this.port?.willReview(request) === true;
    } catch {
      route = false;
    }
    if (!route) return false;
    const controller = new AbortController();
    this.#reviews.set(request.requestId, { request, controller });
    this.#announce(request, 'started');
    void Promise.resolve()
      .then(() => this.port!.review(request, this.history(), controller.signal))
      .catch((): ApprovalReviewResult => ({ kind: 'unavailable', approved: false }))
      .then((review) => {
        if (controller.signal.aborted || this.#reviews.get(request.requestId)?.controller !== controller) return;
        this.#reviews.delete(request.requestId);
        this.#announce(request, 'settled');
        owner.settle(request, review.approved && !this.#stillRouted(request) ? { ...review, approved: false } : review);
      })
      // A settle that cannot commit has already failed its owner; never leave an unhandled rejection.
      .catch(() => undefined);
    return true;
  }

  /**
   * An approval stands only if the session's current generation would still review this request:
   * a rebuild that switched the mode while the review ran (an older generation's settings are a
   * frozen snapshot) must not record an automatic approval.
   */
  #stillRouted(request: InteractionRequest | DirectTaskInteraction): boolean {
    try {
      return this.port?.willReview(request) === true;
    } catch {
      return false;
    }
  }

  has(requestId: InteractionRequestId): boolean {
    return this.#reviews.has(requestId);
  }

  /** A person answered or took over: stop the review and return the request it held. */
  stop(requestId: InteractionRequestId): InteractionRequest | DirectTaskInteraction | undefined {
    const entry = this.#reviews.get(requestId);
    if (!entry) return undefined;
    this.#reviews.delete(requestId);
    entry.controller.abort();
    this.#announce(entry.request, 'settled');
    return entry.request;
  }

  #announce(request: InteractionRequest | DirectTaskInteraction, phase: 'started' | 'settled'): void {
    try {
      this.publish?.({
        type: 'approval_review',
        phase,
        requestId: request.requestId,
        toolName: request.toolName,
        summary: request.summary,
        ...(request.turnId ? { turnId: request.turnId } : {}),
        ...('taskId' in request ? { taskId: request.taskId } : {}),
      });
    } catch {
      // A live observer never decides an approval.
    }
  }
}

/** One reviewer for a conversation's root and task approvals, reading its current generation's port per request. */
export function conversationApprovalReviews(
  port: () => ApprovalReviewPort | undefined,
  history: () => readonly Item[],
  publish: (event: DirectApprovalReviewTransient) => void,
): ApprovalReviews {
  return new ApprovalReviews(
    {
      willReview: (request) => port()?.willReview(request) === true,
      review: (request, accepted, signal) =>
        port()?.review(request, accepted, signal) ?? Promise.resolve({ kind: 'not_reviewed', approved: false }),
    },
    history,
    publish,
  );
}

/** What a person-initiated stop records on the open fact. */
export const REVIEW_STOPPED: ApprovalReviewResult = { kind: 'not_reviewed', approved: false };
