import { normalizeUserTurn } from '../../types/user-turn.js';
import { TurnAttempt } from './turn-attempt.js';
export class TurnAttemptFactory {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    create(input, options = {}) {
        const normalized = normalizeUserTurn(input);
        let turn = this.deps.state.pendingModeNotice?.trim()
            ? { ...normalized, text: `${this.deps.state.pendingModeNotice}\n\n${normalized.text}` }
            : normalized;
        if (!turn.text && options.skipUserMessage && !options.replayFromHistory) {
            try {
                turn = { ...turn, text: this.deps.record.getLastUserMessage() };
            }
            catch {
                // A fresh-start retry can legitimately have no previous user message.
            }
        }
        const token = options.token ?? this.deps.generationGuard.capture();
        if (!this.deps.generationGuard.isCurrent(token))
            return { kind: 'stale' };
        this.deps.record.beginAttempt();
        return {
            kind: 'created',
            attempt: new TurnAttempt({
                turn,
                submittedTurn: normalized,
                token,
                initialRetryCounts: this.#normalizeRetryCounts(options.retries),
                maxTransientRetries: this.deps.resolveRetryLimit(),
                maxModelRetries: options.maxModelRetries,
                recoveryBudget: options.recoveryBudget,
                signal: options.signal,
                onAbort: () => {
                    this.deps.agentClient.abort();
                },
            }),
        };
    }
    #normalizeRetryCounts(retries) {
        const raw = retries ?? {};
        return {
            transientRetryCount: raw.transientRetryCount ?? 0,
            serviceTierFallbackCount: raw.serviceTierFallbackCount ?? raw.flexServiceTierFallbackCount ?? 0,
            modelRetryCount: raw.modelRetryCount ?? raw.hallucinationRetryCount ?? 0,
            transportDowngradeCount: raw.transportDowngradeCount ?? raw.transportFallbackRetryCount ?? 0,
        };
    }
}
//# sourceMappingURL=turn-attempt-factory.js.map