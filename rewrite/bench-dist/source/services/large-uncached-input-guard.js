import crypto from 'crypto';
export const DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG = {
    enabled: true,
    largePromptTokenThreshold: 64_000,
    idleMs: 5 * 60 * 1_000,
};
const serializeInput = (input) => {
    try {
        return JSON.stringify(input) ?? String(input);
    }
    catch {
        return String(input);
    }
};
export const getSerializedInputBytes = (input) => {
    return Buffer.byteLength(serializeInput(input));
};
const estimateTokens = (bytes) => Math.ceil(bytes / 4);
const warningKeyFor = (serializedInput, reasons, context) => {
    const hash = crypto.createHash('sha256');
    hash.update(serializedInput);
    hash.update('\n');
    hash.update([...reasons].sort().join(','));
    hash.update('\n');
    hash.update(JSON.stringify({
        provider: context.provider ?? null,
        model: context.model ?? null,
        reasoningEffort: context.reasoningEffort ?? null,
        mode: context.mode ?? null,
    }));
    return hash.digest('hex').slice(0, 24);
};
const isNonLiteModeTransition = (fromMode, toMode) => {
    const nonLiteModes = new Set(['standard', 'plan', 'mentor', 'orchestrator']);
    return nonLiteModes.has(fromMode ?? 'standard') && nonLiteModes.has(toMode ?? 'standard');
};
const allowDecision = (estimatedTokens = 0, estimatedBytes = 0) => ({
    action: 'allow',
    warningKey: '',
    reasons: [],
    estimatedTokens,
    estimatedBytes,
});
export class LargeUncachedInputGuard {
    #config;
    #lastSuccessful = null;
    #resumedUpdatedAtMs;
    #rewoundSinceSuccess = false;
    constructor(config = {}) {
        this.#config = { ...DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG, ...config };
    }
    reset() {
        this.#lastSuccessful = null;
        this.#resumedUpdatedAtMs = undefined;
        this.#rewoundSinceSuccess = false;
    }
    markResumedSession({ updatedAtMs }) {
        this.#resumedUpdatedAtMs = typeof updatedAtMs === 'number' && Number.isFinite(updatedAtMs) ? updatedAtMs : null;
        this.#rewoundSinceSuccess = false;
        this.#lastSuccessful = null;
    }
    markUndoOrRewind() {
        this.#rewoundSinceSuccess = true;
    }
    /**
     * True when session state alone could produce a warning (idle, resume, undo,
     * provider/model/mode change). Callers that only care about the warn action
     * can skip building and serializing the outgoing payload when this is false.
     *
     * Size is not considered here — a large payload with no risk factors still
     * allows, so a false result is definitive.
     */
    mightWarn(context) {
        if (!this.#config.enabled)
            return false;
        return this.#collectReasons(context).length > 0;
    }
    inspect(context) {
        if (!this.#config.enabled) {
            return allowDecision();
        }
        // Reasons do not depend on payload size. Collect them first so the common
        // "actively chatting, same config" path never serializes the history.
        const reasons = this.#collectReasons(context);
        if (reasons.length === 0) {
            return allowDecision();
        }
        const { estimatedBytes, keyMaterial } = this.#resolveSize(context);
        const estimatedTokens = estimateTokens(estimatedBytes);
        if (estimatedTokens < this.#config.largePromptTokenThreshold) {
            return allowDecision(estimatedTokens, estimatedBytes);
        }
        return {
            action: 'warn',
            warningKey: warningKeyFor(keyMaterial, reasons, context),
            reasons,
            estimatedTokens,
            estimatedBytes,
        };
    }
    #resolveSize(context) {
        if (typeof context.estimatedBytes === 'number' && Number.isFinite(context.estimatedBytes)) {
            return {
                estimatedBytes: Math.max(0, context.estimatedBytes),
                keyMaterial: context.contentKey ?? String(context.estimatedBytes),
            };
        }
        const serialized = serializeInput(context.input);
        return {
            estimatedBytes: Buffer.byteLength(serialized),
            keyMaterial: serialized,
        };
    }
    recordSuccessfulInput(context) {
        this.#lastSuccessful = {
            provider: context.provider,
            model: context.model,
            reasoningEffort: context.reasoningEffort,
            mode: context.mode,
            completedAt: context.now,
        };
        this.#resumedUpdatedAtMs = undefined;
        this.#rewoundSinceSuccess = false;
    }
    #collectReasons(context) {
        const reasons = [];
        if (this.#lastSuccessful) {
            if (this.#lastSuccessful.provider && context.provider && this.#lastSuccessful.provider !== context.provider) {
                reasons.push('provider_changed');
            }
            if (this.#lastSuccessful.model && context.model && this.#lastSuccessful.model !== context.model) {
                reasons.push('model_changed');
            }
            if (this.#lastSuccessful.reasoningEffort &&
                context.reasoningEffort &&
                this.#lastSuccessful.reasoningEffort !== context.reasoningEffort) {
                reasons.push('reasoning_effort_changed');
            }
            if (this.#lastSuccessful.mode &&
                context.mode &&
                this.#lastSuccessful.mode !== context.mode &&
                !isNonLiteModeTransition(this.#lastSuccessful.mode, context.mode)) {
                reasons.push('mode_changed');
            }
        }
        else if (this.#resumedUpdatedAtMs !== undefined) {
            if (this.#resumedUpdatedAtMs === null) {
                reasons.push('resumed_session_unknown_age');
            }
        }
        if (this.#rewoundSinceSuccess) {
            reasons.push('undo_rewind');
        }
        return reasons;
    }
}
//# sourceMappingURL=large-uncached-input-guard.js.map