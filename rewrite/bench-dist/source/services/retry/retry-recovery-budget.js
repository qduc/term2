import { getZeroFrameAmbiguousTimeout } from './retry-errors.js';
/**
 * One bounded capability shared by provider transport retries and session
 * recovery. The owner is deliberately the retry/session layer: providers can
 * consume claims; only accepted terminal model completion ends an episode.
 */
const RETRY_RECOVERY_LIMITS = {
    maxRecoveryTimeMs: 90_000,
    maxPhysicalAttempts: 3,
    maxAutomaticReplays: 1,
};
export class RetryRecoveryBudget {
    maxRecoveryTimeMs;
    maxPhysicalAttempts;
    maxAutomaticReplays;
    #now;
    #startedAt;
    #physicalAttempts = 0;
    #automaticReplays = 0;
    constructor(options = {}) {
        this.#now = options.now ?? (() => performance.now());
        this.maxRecoveryTimeMs = options.maxRecoveryTimeMs ?? RETRY_RECOVERY_LIMITS.maxRecoveryTimeMs;
        this.maxPhysicalAttempts = options.maxPhysicalAttempts ?? RETRY_RECOVERY_LIMITS.maxPhysicalAttempts;
        this.maxAutomaticReplays = options.maxAutomaticReplays ?? RETRY_RECOVERY_LIMITS.maxAutomaticReplays;
    }
    get startedAt() {
        return this.#startedAt;
    }
    get physicalAttempts() {
        return this.#physicalAttempts;
    }
    get automaticReplays() {
        return this.#automaticReplays;
    }
    get elapsedMs() {
        return this.#startedAt === undefined ? 0 : Math.max(0, this.#now() - this.#startedAt);
    }
    /** Starts the recovery clock only after a retryable failure is observed. */
    noteRetryableFailure() {
        if (this.#startedAt === undefined)
            this.#startedAt = this.#now();
    }
    /** Only the run-loop terminal-response owner may end a recovery episode. */
    noteModelResponseCompleted() {
        this.#startedAt = undefined;
        this.#physicalAttempts = 0;
        this.#automaticReplays = 0;
    }
    get deadlineExceeded() {
        return this.#startedAt !== undefined && this.elapsedMs >= this.maxRecoveryTimeMs;
    }
    /**
     * Return the complete non-secret state used by a recovery admission gate.
     * Recovery decisions are otherwise difficult to explain from logs because
     * claims mutate the counters before the next dispatch is made.
     */
    describeAdmission(options) {
        return this.#describeAdmission(options.automaticReplayRequired, this.maxPhysicalAttempts, this.maxAutomaticReplays);
    }
    #describeAdmission(automaticReplayRequired, maxPhysicalAttempts, maxAutomaticReplays) {
        const elapsedMs = this.elapsedMs;
        const snapshot = {
            physicalAttempts: this.physicalAttempts,
            maxPhysicalAttempts,
            automaticReplays: this.automaticReplays,
            maxAutomaticReplays,
            elapsedMs,
            maxRecoveryTimeMs: this.maxRecoveryTimeMs,
            deadlineExceeded: this.#startedAt !== undefined && elapsedMs >= this.maxRecoveryTimeMs,
        };
        const physicalAttemptAllowed = snapshot.physicalAttempts < snapshot.maxPhysicalAttempts && !snapshot.deadlineExceeded;
        const automaticReplayAllowed = snapshot.automaticReplays < snapshot.maxAutomaticReplays && !snapshot.deadlineExceeded;
        return {
            ...snapshot,
            automaticReplayRequired,
            automaticReplayAllowed,
            physicalAttemptAllowed,
            admitted: physicalAttemptAllowed && (!automaticReplayRequired || automaticReplayAllowed),
        };
    }
    /**
     * Admit only an authorized zero-frame ambiguous timeout using the configured
     * retry count and the existing shared counters. Its observed receive wait is
     * not recovery overhead: credit only that wait, never backoff or other work.
     * All other failures retain the original 90s / 3 dispatch / 1 replay envelope.
     * Returns undefined when the typed exception does not apply; no state changes.
     */
    claimZeroFrameTimeoutRecovery(error, options) {
        const timeout = getZeroFrameAmbiguousTimeout(error);
        if (!timeout || !Number.isInteger(options.maxRetries) || options.maxRetries < 0)
            return undefined;
        const zeroFrameWaitCreditMs = Number.isFinite(timeout.waitedMs)
            ? Math.min(this.elapsedMs, Math.max(0, timeout.waitedMs))
            : 0;
        if (this.#startedAt !== undefined)
            this.#startedAt += zeroFrameWaitCreditMs;
        const admission = {
            ...this.#describeAdmission(options.automaticReplayRequired, options.maxRetries, options.maxRetries),
            zeroFrameWaitCreditMs,
        };
        if (admission.admitted) {
            this.#physicalAttempts++;
            if (options.automaticReplayRequired)
                this.#automaticReplays++;
        }
        return admission;
    }
    /**
     * Claim one physical dispatch made because recovery is in progress.
     * Ordinary first attempts and successful tool-loop continuations are not
     * recovery work; their callers must not spend this budget on them.
     */
    claimPhysicalAttempt() {
        if (this.#physicalAttempts >= this.maxPhysicalAttempts || this.deadlineExceeded)
            return false;
        this.#physicalAttempts++;
        return true;
    }
    /** Claim exactly once before an automatic full-history turn replay. */
    claimAutomaticReplay() {
        if (this.#automaticReplays >= this.maxAutomaticReplays || this.deadlineExceeded)
            return false;
        this.#automaticReplays++;
        return true;
    }
    remainingMs() {
        if (this.#startedAt === undefined)
            return undefined;
        return Math.max(0, this.maxRecoveryTimeMs - this.elapsedMs);
    }
}
/**
 * Raised when a provider wrapper tried to start another physical request after
 * the shared recovery envelope was exhausted. Keeping the triggering failure
 * as a cause lets the classifier retain its useful provider/status details
 * without making the budget error itself look like a new provider failure.
 */
export class RetryRecoveryBudgetExhaustedError extends Error {
    cause;
    constructor(cause) {
        super('Retry recovery budget exhausted', { cause });
        this.name = 'RetryRecoveryBudgetExhaustedError';
        this.cause = cause;
    }
}
export const isRetryRecoveryBudgetExhaustedError = (error) => error instanceof RetryRecoveryBudgetExhaustedError;
//# sourceMappingURL=retry-recovery-budget.js.map