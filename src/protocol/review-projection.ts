/**
 * Public shape of the session's approval review (src/session/approval/approval-arbiter.ts):
 * a live `approval_review` event while a request is reviewed and not yet open, the review
 * recorded on the request once a person must decide, and the read-model list of requests
 * still under review. An approval the review answers itself is never published as open.
 */
import type { DirectApprovalReviewTransient } from '../session/approval/approval-arbiter.js';
import type { WireApprovalReview, WireEvent, WireInteraction } from './wire.js';

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

/** The opened interaction, or nothing when the review approved it or unattended refused it (its close follows at once). */
export function reviewedInteraction(
  interaction: WireInteraction,
  review: WireApprovalReview | undefined,
): WireInteraction | undefined {
  if (review?.approved || review?.refused) return undefined;
  return review ? { ...interaction, review } : interaction;
}

export { reduceApprovalReview, withoutReview } from './fold/review.js';
