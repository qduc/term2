import type { InteractionRequest, InteractionRequestId } from '../../engine/index.js';
import type { Item } from '../../model/index.js';
import type { ApprovalReviewResult } from '../../shared/contracts/approval-review.js';
import type { DirectTaskId, DirectTaskInteraction } from '../background-types.js';
import type { ApprovalRoute } from './approval-route.js';

/**
 * The app-supplied reviewer. `willReview` is the synchronous route (the shared
 * decision table with the live mode); `review` performs the model call and
 * returns the judged result, including the grant an approval answers with.
 * Both read the session's current tool generation, so a rebuild between open
 * and settle is honoured.
 */
export type ApprovalReviewPort = {
  willReview(request: InteractionRequest | DirectTaskInteraction): boolean;
  /** The current generation would let a passing review answer this request (mode `auto`), not just inform. */
  mayApprove(request: InteractionRequest | DirectTaskInteraction): boolean;
  /** The current generation's full route; `refuse` and `judge` occur only in `unattended`. */
  route(request: InteractionRequest | DirectTaskInteraction): ApprovalRoute;
  /** The current generation is `unattended`: nothing may wait for a person except a question. */
  unattended(): boolean;
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
  /** Unattended: commit the open with the review and a policy close that refuses it. */
  refuse(request: InteractionRequest | DirectTaskInteraction, review: ApprovalReviewResult, reason?: string): void;
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
        const judged: ApprovalReviewResult =
          review.approved && !this.#stillRouted(request, review)
            ? review.kind === 'bypassed'
              ? { kind: 'not_reviewed', approved: false }
              : { ...review, approved: false }
            : review;
        // A non-approval follows the current mode: refused in `unattended`, opened for a person otherwise.
        if (!judged.approved && this.unattended()) owner.refuse(request, judged);
        else owner.settle(request, judged);
      })
      // A settle that cannot commit has already failed its owner; never leave an unhandled rejection.
      .catch(() => undefined);
    return true;
  }

  /**
   * An approval stands only if the session's current generation would still let a review answer this
   * request: a rebuild that switched the mode while the review ran (an older generation's settings
   * are a frozen snapshot) to `off` or `always` must not record an automatic approval.
   */
  #stillRouted(request: InteractionRequest | DirectTaskInteraction, review: ApprovalReviewResult): boolean {
    try {
      const kind = this.port?.route(request).kind;
      // Permission to review is not permission to reuse an unreviewed bypass after a mode change.
      const sameAuthority = review.kind === 'bypassed' ? kind === 'bypass' : kind === 'decide' || kind === 'judge';
      return sameAuthority && this.port?.mayApprove(request) === true;
    } catch {
      return false;
    }
  }

  /**
   * Why the current generation refuses this request without a review, or undefined when it does not.
   * Called by an owner when `begin` returned false. Fails closed: a route that throws refuses in `unattended`.
   */
  refusal(request: InteractionRequest | DirectTaskInteraction): string | undefined {
    try {
      const route = this.port?.route(request);
      if (route?.kind === 'refuse') return route.reason;
      // Routed to a review that `begin` could not start: unattended refuses rather than ask a person.
      return route?.kind === 'judge' ? 'the approval review could not start' : undefined;
    } catch {
      return this.unattended() ? 'the approval route could not be read' : undefined;
    }
  }

  /** The current generation is `unattended`. Fails closed: an unreadable mode counts as unattended. */
  unattended(): boolean {
    try {
      return this.port?.unattended() === true;
    } catch {
      return true;
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
      mayApprove: (request) => port()?.mayApprove(request) === true,
      route: (request) => port()?.route(request) ?? { kind: 'ask_user' },
      unattended: () => port()?.unattended() === true,
      review: (request, accepted, signal) =>
        port()?.review(request, accepted, signal) ?? Promise.resolve({ kind: 'not_reviewed', approved: false }),
    },
    history,
    publish,
  );
}

/** What a person-initiated stop records on the open fact. */
export const REVIEW_STOPPED: ApprovalReviewResult = { kind: 'not_reviewed', approved: false };
