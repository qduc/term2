/** Requests the session is still reviewing before a person is asked; see ../review-projection.ts. */
import type { WireEventPayloads } from './wire-events.js';
import type { WireReviewingApproval, WireSnapshot } from './wire-types.js';

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
