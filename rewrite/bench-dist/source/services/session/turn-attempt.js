import { RetryRecoveryBudget } from '../retry/retry-recovery-budget.js';
export class TurnAttempt {
    #turn;
    #submittedTurn;
    #token;
    #initialRetryCounts;
    #maxTransientRetries;
    #maxModelRetries;
    #recoveryBudget;
    #retryCounts;
    #stream = null;
    #streamInput = undefined;
    #inputMode = undefined;
    #providerHistorySnapshot = undefined;
    #addedUserMessage = false;
    #modelEventSeen = false;
    #closed = false;
    #signal;
    #abortListener;
    constructor(options) {
        this.#turn = options.turn;
        this.#submittedTurn = options.submittedTurn ?? options.turn;
        this.#token = options.token;
        this.#initialRetryCounts = options.initialRetryCounts;
        this.#maxTransientRetries = options.maxTransientRetries;
        this.#maxModelRetries = options.maxModelRetries;
        this.#recoveryBudget = options.recoveryBudget ?? new RetryRecoveryBudget();
        this.#retryCounts = { ...options.initialRetryCounts };
        this.#signal = options.signal;
        if (this.#signal) {
            if (this.#signal.aborted) {
                if (options.onAbort) {
                    options.onAbort();
                }
                throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
            }
            if (options.onAbort) {
                this.#abortListener = () => {
                    options.onAbort?.();
                };
                this.#signal.addEventListener('abort', this.#abortListener);
            }
        }
    }
    get turn() {
        return this.#turn;
    }
    get submittedTurn() {
        return this.#submittedTurn;
    }
    get token() {
        return this.#token;
    }
    get initialRetryCounts() {
        return this.#initialRetryCounts;
    }
    get maxTransientRetries() {
        return this.#maxTransientRetries;
    }
    get maxModelRetries() {
        return this.#maxModelRetries;
    }
    get recoveryBudget() {
        return this.#recoveryBudget;
    }
    get retryCounts() {
        return this.#retryCounts;
    }
    get stream() {
        return this.#stream;
    }
    get streamInput() {
        return this.#streamInput;
    }
    get inputMode() {
        return this.#inputMode;
    }
    get providerHistorySnapshot() {
        return this.#providerHistorySnapshot;
    }
    get addedUserMessage() {
        return this.#addedUserMessage;
    }
    get modelEventSeen() {
        return this.#modelEventSeen;
    }
    markModelEventSeen() {
        this.#modelEventSeen = true;
    }
    get closed() {
        return this.#closed;
    }
    get signal() {
        return this.#signal;
    }
    markUserMessageAdded() {
        this.#addedUserMessage = true;
    }
    attachInput(plan) {
        this.#streamInput = plan.streamInput;
        this.#inputMode = plan.inputSurgeKind;
        this.#providerHistorySnapshot = plan.providerHistorySnapshot;
    }
    attachStream(stream) {
        this.#stream = stream;
    }
    advanceRetry(nextCounts) {
        this.#retryCounts = { ...nextCounts };
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        if (this.#signal && this.#abortListener) {
            this.#signal.removeEventListener('abort', this.#abortListener);
            this.#abortListener = undefined;
        }
    }
}
//# sourceMappingURL=turn-attempt.js.map