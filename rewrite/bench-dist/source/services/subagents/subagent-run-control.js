import { randomUUID } from 'node:crypto';
import { createAbortError } from './utils.js';
const DEFAULT_MAX_MAILBOX_MESSAGES = 4;
const DEFAULT_MAX_MAILBOX_CHARACTERS = 4_000;
const DEFAULT_MAX_CONTINUATION_SEGMENTS = 3;
const MAX_QUESTION_CHARACTERS = 1_200;
/**
 * Per-logical-run coordination state. The registry owns lifecycle and identity;
 * runners receive only the narrow callbacks they need for a segment.
 */
export class SubagentRunControl {
    #maxMailboxMessages;
    #maxMailboxCharacters;
    #maxContinuationSegments;
    #createQuestionId;
    #controller;
    #abortReason;
    #activeToolCount = 0;
    #interruptWhenToolsIdle = false;
    #cancellationRequested = false;
    #mailbox = [];
    #mailboxCharacters = 0;
    #continuationSegments = 0;
    #question;
    constructor(options = {}) {
        this.#maxMailboxMessages = options.maxMailboxMessages ?? DEFAULT_MAX_MAILBOX_MESSAGES;
        this.#maxMailboxCharacters = options.maxMailboxCharacters ?? DEFAULT_MAX_MAILBOX_CHARACTERS;
        this.#maxContinuationSegments = options.maxContinuationSegments ?? DEFAULT_MAX_CONTINUATION_SEGMENTS;
        this.#createQuestionId = options.createQuestionId ?? randomUUID;
    }
    get currentSegmentController() {
        return this.#controller;
    }
    get activeToolCount() {
        return this.#activeToolCount;
    }
    get cancellationRequested() {
        return this.#cancellationRequested;
    }
    get hasQueuedSteering() {
        return this.#mailbox.length > 0;
    }
    get mailboxLimits() {
        return { messages: this.#maxMailboxMessages, characters: this.#maxMailboxCharacters };
    }
    get mailboxOccupancy() {
        return { messages: this.#mailbox.length, characters: this.#mailboxCharacters };
    }
    get currentSegmentAbortReason() {
        return this.#abortReason;
    }
    get continuationSegments() {
        return this.#continuationSegments;
    }
    canStartContinuation() {
        return !this.#cancellationRequested && this.#continuationSegments < this.#maxContinuationSegments;
    }
    startContinuation() {
        if (!this.canStartContinuation())
            return false;
        this.#continuationSegments++;
        return true;
    }
    get pendingQuestion() {
        return this.#question && { messageId: this.#question.messageId, question: this.#question.question };
    }
    beginSegment() {
        if (this.#controller)
            throw new Error('A subagent segment is already active.');
        const controller = new AbortController();
        this.#controller = controller;
        this.#abortReason = undefined;
        if (this.#cancellationRequested)
            this.#abortCurrentSegment('cancel');
        return controller;
    }
    endSegment(controller) {
        if (this.#controller !== controller)
            return;
        this.#controller = undefined;
        this.#abortReason = undefined;
        this.#activeToolCount = 0;
        this.#interruptWhenToolsIdle = false;
    }
    onToolStart() {
        this.#activeToolCount++;
    }
    onToolComplete() {
        if (this.#activeToolCount === 0)
            return;
        this.#activeToolCount--;
        if (this.#activeToolCount === 0 && this.#interruptWhenToolsIdle)
            this.#abortCurrentSegment();
    }
    enqueueSteering(message) {
        if (this.#mailbox.length + 1 > this.#maxMailboxMessages ||
            this.#mailboxCharacters + message.length > this.#maxMailboxCharacters) {
            return false;
        }
        this.#mailbox.push(message);
        this.#mailboxCharacters += message.length;
        this.#interruptWhenToolsIdle = true;
        if (this.#activeToolCount === 0)
            this.#abortCurrentSegment();
        return true;
    }
    consumeSteering() {
        if (this.#mailbox.length === 0)
            return undefined;
        const messages = this.#mailbox;
        this.#mailbox = [];
        this.#mailboxCharacters = 0;
        return messages.join('\n');
    }
    ask(question) {
        const boundedQuestion = question.trim();
        if (boundedQuestion.length === 0)
            throw new Error('A subagent question cannot be empty.');
        if (boundedQuestion.length > MAX_QUESTION_CHARACTERS)
            throw new Error(`Question exceeds ${MAX_QUESTION_CHARACTERS} characters.`);
        if (this.#question)
            throw new Error('A subagent question is already pending.');
        let resolve;
        let reject;
        const answer = new Promise((resolveAnswer, rejectAnswer) => {
            resolve = resolveAnswer;
            reject = rejectAnswer;
        });
        const pending = { messageId: this.#createQuestionId(), question: boundedQuestion, resolve, reject };
        this.#question = pending;
        return { messageId: pending.messageId, question: boundedQuestion, answer };
    }
    answer(messageId, answer) {
        if (!this.#question || this.#question.messageId !== messageId)
            return false;
        const pending = this.#question;
        this.#question = undefined;
        pending.resolve(answer);
        return true;
    }
    requestCancellation() {
        this.#cancellationRequested = true;
        this.#mailbox = [];
        this.#mailboxCharacters = 0;
        this.#rejectPendingQuestion(createAbortError('The subagent run was cancelled.'));
        this.#abortCurrentSegment('cancel');
    }
    settle(reason = createAbortError('The subagent run was cancelled.')) {
        this.#mailbox = [];
        this.#mailboxCharacters = 0;
        this.#rejectPendingQuestion(reason);
    }
    #rejectPendingQuestion(reason) {
        if (!this.#question)
            return;
        const pending = this.#question;
        this.#question = undefined;
        pending.reject(reason);
    }
    #abortCurrentSegment(reason = 'steer') {
        this.#abortReason = reason;
        if (this.#controller && !this.#controller.signal.aborted)
            this.#controller.abort();
    }
}
//# sourceMappingURL=subagent-run-control.js.map