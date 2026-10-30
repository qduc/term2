import { isAskUserTerminalAnswer } from '../../tools/agent/ask-user-constants.js';
export function getAskUserQuestions(approval) {
    try {
        const parsed = JSON.parse(approval.argumentsText);
        return Array.isArray(parsed.questions) ? parsed.questions : [];
    }
    catch {
        return [];
    }
}
function cloneSnapshot(interaction) {
    return {
        interactionId: interaction.interactionId,
        revision: interaction.revision,
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
    #current = null;
    #nextInteractionId = 1;
    #nextRevision = 1;
    #observer = null;
    /** Prepare an adopted transition without mutating or publishing live state. */
    prepareTransition(transition) {
        const original = this.#current;
        const nextId = this.#nextInteractionId;
        const nextRevision = this.#nextRevision;
        const draft = new PendingInteractionState();
        draft.#current = original
            ? {
                ...original,
                askUserAnswers: original.askUserAnswers.map((answer) => (Array.isArray(answer) ? [...answer] : answer)),
            }
            : null;
        draft.#nextInteractionId = nextId;
        draft.#nextRevision = nextRevision;
        const value = transition(draft);
        const snapshot = draft.getSnapshot();
        let committed = false;
        return {
            value,
            snapshot,
            commit: () => {
                if (committed ||
                    this.#current !== original ||
                    this.#nextInteractionId !== nextId ||
                    this.#nextRevision !== nextRevision)
                    throw new Error('Pending interaction transition is stale');
                committed = true;
                if (draft.#nextInteractionId === nextId &&
                    draft.#nextRevision === nextRevision &&
                    ((draft.#current === null && original === null) ||
                        (draft.#current !== null && original !== null && draft.#current.revision === original.revision)))
                    return;
                this.#current = draft.#current;
                this.#nextInteractionId = draft.#nextInteractionId;
                this.#nextRevision = draft.#nextRevision;
                this.#observer?.(this.getSnapshot());
            },
        };
    }
    getSnapshot() {
        return this.#current ? cloneSnapshot(this.#current) : null;
    }
    setObserver(observer) {
        this.#observer = observer;
        observer?.(this.getSnapshot());
    }
    present(approval) {
        this.#current = {
            interactionId: this.#nextInteractionId++,
            revision: this.#nextRevision++,
            approval,
            askUserAnswers: [],
            currentAskUserQuestionIndex: 0,
        };
        return this.#publish();
    }
    clear() {
        if (!this.#current)
            return;
        this.#current = null;
        this.#observer?.(null);
    }
    goToPreviousQuestion() {
        const current = this.#current;
        if (!current || current.currentAskUserQuestionIndex <= 0)
            return;
        current.currentAskUserQuestionIndex -= 1;
        current.askUserAnswers.pop();
        this.#publish();
    }
    /**
     * Kept as a characterization of the existing prompt behavior: forward
     * navigation changes the displayed question before an answer is recorded.
     */
    goToNextQuestion() {
        const current = this.#current;
        if (!current)
            return;
        current.currentAskUserQuestionIndex += 1;
        this.#publish();
    }
    resolve(request) {
        const current = this.#current;
        if (!current)
            return { kind: 'none' };
        if (current.interactionId !== request.expectedInteractionId) {
            return {
                kind: 'stale_interaction',
                expectedInteractionId: request.expectedInteractionId,
                currentInteractionId: current.interactionId,
            };
        }
        if (request.expectedRevision !== undefined && current.revision !== request.expectedRevision) {
            return {
                kind: 'stale_interaction',
                expectedInteractionId: request.expectedInteractionId,
                currentInteractionId: current.interactionId,
            };
        }
        let approvalAnswer = request.approvalAnswer;
        if (current.approval.toolName === 'ask_user' &&
            request.answer === 'y' &&
            !isAskUserTerminalAnswer(approvalAnswer)) {
            const questions = getAskUserQuestions(current.approval);
            let parsedAnswer = approvalAnswer ?? '';
            const currentQuestion = questions[current.askUserAnswers.length];
            if (currentQuestion?.is_multi_select) {
                try {
                    const parsed = JSON.parse(approvalAnswer ?? '');
                    if (Array.isArray(parsed)) {
                        parsedAnswer = parsed.filter((item) => typeof item === 'string');
                    }
                }
                catch {
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
        const resolution = {
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
    #publish() {
        if (this.#current)
            this.#current.revision = this.#nextRevision++;
        const snapshot = this.getSnapshot();
        if (!snapshot)
            throw new Error('Cannot publish an absent pending interaction');
        this.#observer?.(snapshot);
        return snapshot;
    }
}
//# sourceMappingURL=pending-interaction-state.js.map