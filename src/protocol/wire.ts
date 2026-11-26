/**
 * Old path of the wire vocabulary, which lives in the shared fold (./fold/). It also narrows the fold's
 * host-owned detail types to term2's own, and checks that the fold's structural copies of term2 types have
 * not drifted from the originals.
 */
import type { ModelRequestCost } from '../session/recovery-budget.js';
import type { DirectFinalWindow } from '../session/final.js';
import type { ApprovalReviewResult } from '../shared/contracts/approval-review.js';
import type { CodexWeeklyQuota } from '../model/index.js';
import type { WireApprovalReview, WireCodexQuota } from './fold/wire-types.js';

export * from './fold/wire-types.js';
export type * from './fold/wire-events.js';
export { ASK_USER_NO_ANSWER_RESULT } from '../tools/adopted/ask-user-constants.js';

declare module './fold/wire-host-types.js' {
  interface WireHostTypes {
    readonly finalWindow: DirectFinalWindow;
    readonly modelRequestCost: ModelRequestCost;
  }
}

/** Both directions assignable, or this file does not compile: the fold's copy changed or the original did. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameTypes: [Same<WireApprovalReview, ApprovalReviewResult>, Same<WireCodexQuota, CodexWeeklyQuota>] = [
  true,
  true,
];
void sameTypes;
