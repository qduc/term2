import type { InteractionDecision, InteractionRequest, InteractionRequestId } from '../../engine/index.js';
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
  /** True when the session runs under a non-interactive headless policy (D003). */
  isHeadless?(): boolean;
  /** Non-interactive policy decision run by the session when no interactive person is present. */
  decideHeadless?(
    request: InteractionRequest | DirectTaskInteraction,
    history: readonly Item[],
    review: ApprovalReviewResult | undefined,
    signal: AbortSignal,
  ): Promise<InteractionDecision>;
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
  /** Commit the open (and, when approved or policy-decided, the close) and release the waiter. */
  settle(
    request: InteractionRequest | DirectTaskInteraction,
    review: ApprovalReviewResult | undefined,
    policyDecision?: InteractionDecision,
  ): void;
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
    {
      readonly request: InteractionRequest | DirectTaskInteraction;
      readonly controller: AbortController;
      readonly announce: boolean;
    }
  >();

  constructor(
    private readonly port: ApprovalReviewPort | undefined,
    private readonly history: () => readonly Item[],
    private readonly publish: ((event: DirectApprovalReviewTransient) => void) | undefined,
  ) {}

  /** Start a review (or headless policy settlement) when applicable; false means the owner handles opening now. */
  begin(request: InteractionRequest | DirectTaskInteraction, owner: Owner): boolean {
    let route = false;
    let routeKind: ApprovalRoute['kind'] | undefined;
    try {
      route = this.port?.willReview(request) === true;
      routeKind = this.port?.route(request).kind;
    } catch {
      route = false;
    }
    if (route) {
      const controller = new AbortController();
      this.#reviews.set(request.requestId, { request, controller, announce: true });
      this.#announce(request, 'started');
      void Promise.resolve()
        .then(() => this.port!.review(request, this.history(), controller.signal))
        .catch((): ApprovalReviewResult => ({ kind: 'unavailable', approved: false }))
        .then(async (review) => {
          if (controller.signal.aborted || this.#reviews.get(request.requestId)?.controller !== controller) return;
          this.#announce(request, 'settled');
          const judged: ApprovalReviewResult =
            review.approved && !this.#stillRouted(request, review)
              ? review.kind === 'bypassed'
                ? { kind: 'not_reviewed', approved: false }
                : { ...review, approved: false }
              : review;
          // A non-approval follows the current mode: refused in `unattended`, headless policy in headless, else a person.
          if (!judged.approved && this.unattended()) {
            this.#reviews.delete(request.requestId);
            owner.refuse(request, judged);
            return;
          }
          if (!judged.approved && this.isHeadless() && this.port?.decideHeadless) {
            const decision = await this.#runHeadlessDecision(request, judged, controller);
            if (controller.signal.aborted || this.#reviews.get(request.requestId)?.controller !== controller) return;
            this.#reviews.delete(request.requestId);
            owner.settle(request, judged, decision);
            return;
          }
          this.#reviews.delete(request.requestId);
          owner.settle(request, judged);
        })
        // A settle that cannot commit has already failed its owner; never leave an unhandled rejection.
        .catch(() => undefined);
      return true;
    }
    // Unattended hard-gate refusals still go through `refusal()` so they record `refused: true` and count refusals.
    if (routeKind === 'refuse' || routeKind === 'judge') return false;
    if (!this.isHeadless() || !this.port?.decideHeadless) return false;
    const controller = new AbortController();
    this.#reviews.set(request.requestId, { request, controller, announce: false });
    void this.#runHeadlessDecision(request, undefined, controller)
      .then((decision) => {
        if (controller.signal.aborted || this.#reviews.get(request.requestId)?.controller !== controller) return;
        this.#reviews.delete(request.requestId);
        owner.settle(request, undefined, decision);
      })
      .catch(() => undefined);
    return true;
  }

  async #runHeadlessDecision(
    request: InteractionRequest | DirectTaskInteraction,
    review: ApprovalReviewResult | undefined,
    controller: AbortController,
  ): Promise<InteractionDecision> {
    try {
      return await this.port!.decideHeadless!(request, this.history(), review, controller.signal);
    } catch {
      return request.kind === 'question'
        ? { kind: 'answer', answer: '', stopAfterApprovalResolution: true }
        : { kind: 'deny', reason: 'No person is available to approve this in a non-interactive run.' };
    }
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

  /** True when the current generation runs under a non-interactive headless policy. */
  isHeadless(): boolean {
    try {
      return this.port?.isHeadless?.() === true;
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
    if (entry.announce) this.#announce(entry.request, 'settled');
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
      isHeadless: () => port()?.isHeadless?.() === true,
      decideHeadless: (request, accepted, review, signal) =>
        port()?.decideHeadless?.(request, accepted, review, signal) ??
        Promise.resolve(
          request.kind === 'question'
            ? { kind: 'answer', answer: '', stopAfterApprovalResolution: true }
            : { kind: 'deny', reason: 'No person is available to approve this in a non-interactive run.' },
        ),
      review: (request, accepted, signal) =>
        port()?.review(request, accepted, signal) ?? Promise.resolve({ kind: 'not_reviewed', approved: false }),
    },
    history,
    publish,
  );
}

/** What a person-initiated stop records on the open fact. */
export const REVIEW_STOPPED: ApprovalReviewResult = { kind: 'not_reviewed', approved: false };

/** Resolve the effective policy decision (automatic review approval or headless policy) and recorded review. */
export function resolveApprovalDecision<R extends InteractionRequest | DirectTaskInteraction>(
  request: R,
  review: ApprovalReviewResult | undefined,
  policyDecision: InteractionDecision | undefined,
  isValid: (request: R, decision: InteractionDecision) => boolean,
): {
  readonly automatic: boolean;
  readonly decision: InteractionDecision | undefined;
  readonly recordedReview: ApprovalReviewResult | undefined;
} {
  const reviewDecision: InteractionDecision | undefined = review?.approved
    ? review.grant
      ? { kind: 'allow', grant: review.grant }
      : { kind: 'allow' }
    : undefined;
  const automatic = reviewDecision && isValid(request, reviewDecision) ? reviewDecision : undefined;
  const decision = automatic ?? (policyDecision && isValid(request, policyDecision) ? policyDecision : undefined);
  const recordedReview = review
    ? automatic
      ? review
      : ({ ...review, approved: false } as ApprovalReviewResult)
    : undefined;
  return { automatic: automatic !== undefined, decision, recordedReview };
}
