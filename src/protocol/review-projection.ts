/**
 * Public shape of the session's approval review (src/session/approval/approval-arbiter.ts):
 * a live `approval_review` event while a request is reviewed and not yet open, the review
 * recorded on the request once a person must decide, and the read-model list of requests
 * still under review. An approval the review answers itself is never published as open.
 */
import type { DirectApprovalReviewTransient } from '../session/approval/approval-arbiter.js';
import type { WireEventPayloads } from './wire-events.js';
import type { WireApprovalReview, WireEvent, WireInteraction, WireReviewingApproval, WireSnapshot } from './wire.js';

/** A transient (null seq) review frame; it never stands for an open or resolved request. */
export function approvalReviewEvent(sessionId: string, event: DirectApprovalReviewTransient): WireEvent {
  const { phase, requestId, toolName, summary, turnId, taskId } = event;
  return {
    sessionId,
    seq: null,
    occurredAt: null,
    turnId: turnId ?? null,
    type: 'approval_review',
    payload: {
      phase,
      approval: { requestId, toolName, summary, ...(turnId ? { turnId } : {}), ...(taskId ? { taskId } : {}) },
    },
  };
}

/** The opened interaction, or nothing when the review approved it (its close follows at once). */
export function reviewedInteraction(
  interaction: WireInteraction,
  review: WireApprovalReview | undefined,
): WireInteraction | undefined {
  if (review?.approved) return undefined;
  return review ? { ...interaction, review } : interaction;
}

export function reduceApprovalReview(state: WireSnapshot, payload: WireEventPayloads['approval_review']): WireSnapshot {
  const others = withoutReview(state, payload.approval.requestId);
  if (payload.phase !== 'started') return others;
  return { ...others, reviewingApprovals: [...(others.reviewingApprovals ?? []), payload.approval] };
}

/** A request leaves review once it opens or resolves, whatever the order of live and durable events. */
export function withoutReview(state: WireSnapshot, requestId: string): WireSnapshot {
  if (!state.reviewingApprovals?.some((item: WireReviewingApproval) => item.requestId === requestId)) return state;
  const reviewingApprovals = state.reviewingApprovals.filter((item) => item.requestId !== requestId);
  const { reviewingApprovals: _previous, ...rest } = state;
  return reviewingApprovals.length ? { ...rest, reviewingApprovals } : rest;
}
