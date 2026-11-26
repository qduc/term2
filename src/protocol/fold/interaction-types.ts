/** What a request for a person carries: its grants, questions and decisions, and the review before it opens. */
import type { JsonValue, WireOrigin, WireTaskOwner } from './wire-types.js';

export type WireGrant =
  | 'network-allow-once'
  | 'allow-project'
  | 'allow-remember'
  | 'unsandboxed-once'
  | 'allow-folder-session'
  | 'allow-edit-file-session'
  | 'allow-edit-folder-session'
  | 'docker-allow-once'
  | 'docker-allow-session'
  | 'docker-allow-project';
export type WireQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiple: boolean;
  readonly allowCustom: boolean;
};
export type WireQuestionAnswer = { readonly questionId: string; readonly value: string | readonly string[] };
export type WireDecision = (
  | { readonly kind: 'allow' }
  | { readonly kind: 'decline' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'answer'; readonly answer: string }
  | { readonly kind: 'answers'; readonly answers: readonly WireQuestionAnswer[] }
  | { readonly kind: 'grant'; readonly grant: WireGrant }
) & { readonly stopAfterApprovalResolution?: boolean };
export type WireInteraction = {
  readonly requestId: string;
  readonly turnId: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string;
  readonly taskId?: string;
  /** Accepted task descriptor ownership, independent of the child request turn. */
  readonly taskOwner?: WireTaskOwner;
  readonly sessionId?: string;
  readonly origin?: WireOrigin;
  readonly kind: 'approval' | 'question';
  readonly toolName: string;
  readonly input: JsonValue;
  readonly summary: string;
  readonly detail?: string;
  readonly risk?: 'low' | 'medium' | 'high';
  readonly presentation?: { readonly [key: string]: JsonValue };
  readonly questions?: readonly WireQuestion[];
  /** Only grants the tool request itself offers; Session rejects any other. */
  readonly supportedGrants: readonly WireGrant[];
  /** The session's approval review before this request reached a person, when one ran. */
  readonly review?: WireApprovalReview;
};
/**
 * The session's approval review as recorded on the open fact (term2: src/shared/contracts/approval-review.ts,
 * which ../wire.ts asserts is the same type).
 */
export type WireApprovalReview = (
  | { readonly kind: 'not_reviewed'; readonly approved: false }
  | { readonly kind: 'unavailable'; readonly approved: false }
  | { readonly kind: 'bypassed'; readonly approved: true; readonly grant?: string }
  | {
      readonly kind: 'reviewed';
      readonly approved: boolean;
      /** The grant an approved review answers with; absent means a plain allow. */
      readonly grant?: string;
      /** Advisory assessment only: the verdict informs the person and never answers the request. */
      readonly advisoryOnly?: true;
      readonly advisory: {
        readonly approved: boolean;
        readonly reasoning: string;
        readonly model: string;
        readonly source?: 'llm' | 'system';
        readonly riskLevel?: 'low' | 'medium' | 'high';
        readonly authorization?: 'explicit' | 'implied' | 'weak' | 'unknown';
        readonly confidence?: 'high' | 'low';
      };
    }
) & {
  readonly refused?: true;
  /** Human-prompt visibility; absent on historical records. Raw evidence remains recorded. */
  readonly showReview?: boolean;
};
/** A request the session is reviewing; it is not open and no one is asked yet. */
export type WireReviewingApproval = {
  readonly requestId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly turnId?: string;
  readonly taskId?: string;
};
