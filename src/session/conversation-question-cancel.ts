import { ASK_USER_NO_ANSWER_RESULT } from '../shared/tools/agent/ask-user-constants.js';
import type { InteractionDecision } from '../tools/index.js';

const NOTICE =
  '<system-notice>\nThe user cancelled the pending question without answering (they pressed Escape). Do not resume, continue, or restate the plan or work that was in progress when you asked; treat it as dropped. Act only on the genuinely new input in this turn.\n</system-notice>';

/**
 * Legacy's one-shot notice after an Escaped question. Escape arms it; only an
 * explicit follow-up submission (not Enter, which steers) disarms it; the
 * first input released as a queued follow-up carries it, durably.
 */
export class QuestionCancelNotice {
  #armed = false;

  answered(decision: InteractionDecision): void {
    if (
      decision.kind === 'answer' &&
      decision.answer === ASK_USER_NO_ANSWER_RESULT &&
      decision.stopAfterApprovalResolution
    )
      this.#armed = true;
  }

  submitted(delivery: string | undefined): void {
    if (delivery !== 'steer' && delivery !== 'auto') this.#armed = false;
  }

  /** Never spent on a direct start: legacy keeps it armed past one. */
  take(queuedFollowUp: boolean): string | undefined {
    if (!this.#armed || !queuedFollowUp) return undefined;
    this.#armed = false;
    return NOTICE;
  }
}

export { ASK_USER_NO_ANSWER_RESULT };
