import type { PendingApproval } from '../../contracts/conversation.js';
import { isAskUserTerminalAnswer } from '../../tools/agent/ask-user-constants.js';

export type AskUserAnswer = string | string[];

/**
 * The session-owned description of an interaction which blocks foreground
 * progress. It deliberately contains no Ink state: focus and composer entry
 * mode remain presentation concerns.
 */
export type PendingInteractionSnapshot = {
  readonly interactionId: number;
  readonly approval: PendingApproval;
  readonly askUserAnswers: readonly AskUserAnswer[];
  readonly currentAskUserQuestionIndex: number;
};

export type ResolvePendingInteractionRequest = {
  readonly expectedInteractionId: number;
  readonly answer: string;
  readonly rejectionReason?: string;
  readonly approvalAnswer?: string;
};

export type PendingInteractionResolution =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'stale_interaction';
      readonly expectedInteractionId: number;
      readonly currentInteractionId: number;
    }
  | {
      readonly kind: 'awaiting_next_question';
      readonly interactionId: number;
      readonly snapshot: PendingInteractionSnapshot;
    }
  | {
      readonly kind: 'resolved';
      readonly interactionId: number;
      readonly approval: PendingApproval;
      readonly answer: string;
      readonly rejectionReason?: string;
      readonly approvalAnswer?: string;
    };

type MutablePendingInteraction = {
  interactionId: number;
  approval: PendingApproval;
  askUserAnswers: AskUserAnswer[];
  currentAskUserQuestionIndex: number;
};

type AskUserQuestion = { is_multi_select?: boolean };

function getAskUserQuestions(approval: PendingApproval): AskUserQuestion[] {
  try {
    const parsed = JSON.parse(approval.argumentsText) as { questions?: unknown };
    return Array.isArray(parsed.questions) ? (parsed.questions as AskUserQuestion[]) : [];
  } catch {
    return [];
  }
}

function cloneSnapshot(interaction: MutablePendingInteraction): PendingInteractionSnapshot {
  return {
    interactionId: interaction.interactionId,
    approval: interaction.approval,
    askUserAnswers: interaction.askUserAnswers.map((answer) => (Array.isArray(answer) ? [...answer] : answer)),
    currentAskUserQuestionIndex: interaction.currentAskUserQuestionIndex,
  };
}

/**
 * Authoritative interaction protocol for one session.
 *
 * The state owns the pending approval, multi-question ask_user answers and
 * navigation index. Consumers subscribe to immutable snapshots and send only
 * semantic commands, so they cannot accidentally complete a different
 * interaction after a continuation has produced a new approval.
 */
export class PendingInteractionState {
  #current: MutablePendingInteraction | null = null;
  #nextInteractionId = 1;
  #observer: ((snapshot: PendingInteractionSnapshot | null) => void) | null = null;

  getSnapshot(): PendingInteractionSnapshot | null {
    return this.#current ? cloneSnapshot(this.#current) : null;
  }

  setObserver(observer: ((snapshot: PendingInteractionSnapshot | null) => void) | null): void {
    this.#observer = observer;
    observer?.(this.getSnapshot());
  }

  present(approval: PendingApproval): PendingInteractionSnapshot {
    this.#current = {
      interactionId: this.#nextInteractionId++,
      approval,
      askUserAnswers: [],
      currentAskUserQuestionIndex: 0,
    };
    return this.#publish();
  }

  clear(): void {
    if (!this.#current) return;
    this.#current = null;
    this.#observer?.(null);
  }

  goToPreviousQuestion(): void {
    const current = this.#current;
    if (!current || current.currentAskUserQuestionIndex <= 0) return;
    current.currentAskUserQuestionIndex -= 1;
    current.askUserAnswers.pop();
    this.#publish();
  }

  /**
   * Kept as a characterization of the existing prompt behavior: forward
   * navigation changes the displayed question before an answer is recorded.
   */
  goToNextQuestion(): void {
    const current = this.#current;
    if (!current) return;
    current.currentAskUserQuestionIndex += 1;
    this.#publish();
  }

  resolve(request: ResolvePendingInteractionRequest): PendingInteractionResolution {
    const current = this.#current;
    if (!current) return { kind: 'none' };
    if (current.interactionId !== request.expectedInteractionId) {
      return {
        kind: 'stale_interaction',
        expectedInteractionId: request.expectedInteractionId,
        currentInteractionId: current.interactionId,
      };
    }

    let approvalAnswer = request.approvalAnswer;
    if (
      current.approval.toolName === 'ask_user' &&
      request.answer === 'y' &&
      !isAskUserTerminalAnswer(approvalAnswer)
    ) {
      const questions = getAskUserQuestions(current.approval);
      let parsedAnswer: AskUserAnswer = approvalAnswer ?? '';
      const currentQuestion = questions[current.askUserAnswers.length];
      if (currentQuestion?.is_multi_select) {
        try {
          const parsed = JSON.parse(approvalAnswer ?? '');
          if (Array.isArray(parsed)) {
            parsedAnswer = parsed.filter((item): item is string => typeof item === 'string');
          }
        } catch {
          // Preserve the previous plain-text fallback for malformed input.
        }
      }

      const nextAnswers = [...current.askUserAnswers, parsedAnswer];
      current.askUserAnswers = nextAnswers;
      current.currentAskUserQuestionIndex = nextAnswers.length;
      if (nextAnswers.length < questions.length) {
        return {
          kind: 'awaiting_next_question',
          interactionId: current.interactionId,
          snapshot: this.#publish(),
        };
      }
      approvalAnswer = JSON.stringify(nextAnswers);
    }

    const resolution: PendingInteractionResolution = {
      kind: 'resolved',
      interactionId: current.interactionId,
      approval: current.approval,
      answer: request.answer,
      ...(request.rejectionReason ? { rejectionReason: request.rejectionReason } : {}),
      ...(approvalAnswer !== undefined ? { approvalAnswer } : {}),
    };
    this.clear();
    return resolution;
  }

  #publish(): PendingInteractionSnapshot {
    const snapshot = this.getSnapshot();
    if (!snapshot) throw new Error('Cannot publish an absent pending interaction');
    this.#observer?.(snapshot);
    return snapshot;
  }
}
