import { sanitizeApprovalReviewText, type ApprovalReviewResult } from '../../shared/contracts/approval-review.js';
import type { Fact } from '../facts.js';

/**
 * Unattended approval: a request nobody may answer is refused to the model, and
 * repeated refusals end the turn. See
 * docs/plans/approvals-and-sandbox/unattended-approval.md (decision 3) and
 * docs/plans/approvals-and-sandbox/guard-ledger.md for the limit.
 *
 * Guard: refusal limit. It stops a run that keeps hitting the same wall with no
 * person to notice. Values are the build brief's starting points (Codex ships 3
 * consecutive; Claude Code 3 consecutive), not calibrated on Term2 runs. A false
 * positive ends the turn early with every refusal listed; the user resubmits.
 */
const UNATTENDED_REFUSAL_LIMIT = { consecutive: 3, total: 10 } as const;

type UnattendedRefusal = {
  readonly toolName: string;
  readonly summary: string;
  readonly reason: string;
};

/** Why a request was refused, from the review that ran (or the route that skipped it). */
function refusalCause(review: ApprovalReviewResult | undefined, unreviewed?: string): string {
  if (unreviewed) return unreviewed;
  if (!review || review.kind === 'not_reviewed') return 'it was not reviewed';
  if (review.kind === 'unavailable') return 'the approval review was unavailable, so it could not be approved';
  const reasoning = sanitizeApprovalReviewText(review.advisory.reasoning).trim();
  return `the approval reviewer did not approve it${reasoning ? `: ${reasoning}` : ''}`;
}

/** The text the model receives as the refused call's result. */
function refusalMessage(refusal: UnattendedRefusal, limitReached: boolean): string {
  const head = `Refused by unattended approval (no person is available to approve): ${refusal.summary}. Reason: ${refusal.reason}.`;
  return limitReached
    ? `${head} The refusal limit for this run was reached, so the run stops here.`
    : `${head} Do not retry it or route around it. Take a different approach that needs no approval, or finish and report what you could not do.`;
}

/** Counts one turn's (or one task's) refusals; consecutive resets on any result that is not a refusal. */
export class UnattendedRefusals {
  #consecutive = 0;
  readonly #refusals: UnattendedRefusal[] = [];
  #limited = false;

  /**
   * Count one refusal and build its policy denial and the review its open fact records. The refusal that
   * reaches the limit stops the run; `listAtLimit` puts the run's refusal list in that denial (a task has
   * no terminal notice of its own).
   */
  refuse(
    request: { readonly toolName: string; readonly summary: string },
    review: ApprovalReviewResult,
    unreviewed?: string,
    listAtLimit = false,
  ): { readonly denial: RefusalDenial; readonly review: ApprovalReviewResult } {
    const refusal = { toolName: request.toolName, summary: request.summary, reason: refusalCause(review, unreviewed) };
    const limited = this.#record(refusal);
    const message = refusalMessage(refusal, limited);
    return {
      denial: {
        kind: 'deny',
        reason: limited && listAtLimit ? `${message}\n\n${this.report()}` : message,
        ...(limited ? { stopAfterApprovalResolution: true as const } : {}),
      },
      review: { ...review, approved: false, refused: true } as ApprovalReviewResult,
    };
  }

  #record(refusal: UnattendedRefusal): boolean {
    this.#refusals.push(refusal);
    this.#consecutive += 1;
    if (
      this.#consecutive >= UNATTENDED_REFUSAL_LIMIT.consecutive ||
      this.#refusals.length >= UNATTENDED_REFUSAL_LIMIT.total
    )
      this.#limited = true;
    return this.#limited;
  }

  get limited(): boolean {
    return this.#limited;
  }

  /** A result that was not a refusal. */
  reset(): void {
    this.#consecutive = 0;
  }

  /** The end-of-run listing of every refusal and its reason; empty when nothing was refused. */
  report(): string {
    if (this.#refusals.length === 0) return '';
    const lines = this.#refusals.map((r, index) => `${index + 1}. ${r.toolName}: ${r.summary} — ${r.reason}`);
    const n = `${this.#refusals.length} refused request${this.#refusals.length === 1 ? '' : 's'}`;
    return [
      this.#limited
        ? `Unattended approval stopped this run after ${n} (limit: ${UNATTENDED_REFUSAL_LIMIT.consecutive} in a row or ${UNATTENDED_REFUSAL_LIMIT.total} in total).`
        : `Unattended approval refused ${n} in this run.`,
      ...lines,
    ].join('\n');
  }
}

/** A refusal as the interaction's decision. */
type RefusalDenial = { readonly kind: 'deny'; readonly reason: string; readonly stopAfterApprovalResolution?: true };

/** A turn's refusals and its snapshot report reach its end as one notice; the refusal limit is a blocked terminal cause. */
export function withUnattendedReport(
  ended: Extract<Fact, { type: 'turn_ended' }>,
  refusals: UnattendedRefusals,
  snapshot: string | undefined,
): Extract<Fact, { type: 'turn_ended' }> {
  const report = [refusals.report(), snapshot].filter(Boolean).join('\n\n');
  if (!report) return ended;
  return {
    ...ended,
    ...(refusals.limited && ended.outcome === 'completed' && !ended.terminalCause
      ? { terminalCause: 'approval_refusal_limit' as const }
      : {}),
    notice: ended.notice ? `${ended.notice}\n\n${report}` : report,
  };
}
