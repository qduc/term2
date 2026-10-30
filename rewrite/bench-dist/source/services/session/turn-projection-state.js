import { RetryRecoveryBudget } from '../retry/retry-recovery-budget.js';
/**
 * Session projection and recovery facts for one whole turn. This object does not
 * encode a waiting position: ApplicationRunLoop retains that position on its async
 * stack, including across manual decisions. Decision handles stay with approval policy;
 * emitted ids and usage reconcile its public stream views.
 */
export class TurnProjectionState {
    token;
    source;
    previouslyEmittedIds;
    inputMode;
    cumulativeUsage;
    retryCounts;
    lastStream;
    /** Shared with the initial attempt that started this logical turn, when one exists. */
    recoveryBudget;
    constructor(token, recoveryBudget) {
        this.token = token;
        this.recoveryBudget = recoveryBudget ?? new RetryRecoveryBudget();
        this.source = 'startStream';
        this.previouslyEmittedIds = new Set();
        this.inputMode = 'delta';
        this.retryCounts = {
            transientRetryCount: 0,
            serviceTierFallbackCount: 0,
            modelRetryCount: 0,
            transportDowngradeCount: 0,
        };
        this.lastStream = null;
    }
    /** A recovery may rebuild the attempt; it retains this projection object's identity. */
    resetForAttempt(inputMode) {
        this.source = 'startStream';
        this.previouslyEmittedIds = new Set();
        this.inputMode = inputMode;
        this.cumulativeUsage = undefined;
        this.retryCounts = {
            transientRetryCount: 0,
            serviceTierFallbackCount: 0,
            modelRetryCount: 0,
            transportDowngradeCount: 0,
        };
        this.lastStream = null;
    }
    /** Bind the pending decision without replacing accumulated projection facts. */
    bindDecision(prepared) {
        this.source = prepared.source;
        this.inputMode = prepared.inputMode ?? this.inputMode;
    }
    setLastStream(stream) {
        this.lastStream = stream;
    }
    setCumulativeUsage(usage) {
        this.cumulativeUsage = usage;
    }
    setRetryCounts(counts) {
        this.retryCounts = counts;
    }
}
//# sourceMappingURL=turn-projection-state.js.map