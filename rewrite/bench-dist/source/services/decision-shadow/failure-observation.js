import { classifyProviderFailure, isClassifiedCancellation } from '../retry/provider-failure-classification.js';
/** A failure leaving this run loop, before any session-level recovery. */
export function buildFailureObservation(error, request) {
    const failure = classifyProviderFailure(error);
    const cancelled = isClassifiedCancellation(error);
    return {
        evidence: {
            ...request,
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            ...(failure.code ? { code: failure.code } : {}),
            ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
            message: failure.message.length <= 500 ? failure.message : `${failure.message.slice(0, 500)}… [truncated]`,
            transport: {
                ...(error instanceof Error && error.name ? { errorName: error.name } : {}),
                ...(error instanceof Error && error.cause instanceof Error ? { causeName: error.cause.name || 'Error' } : {}),
            },
        },
        comparison: {
            errorKind: failure.errorKind,
            retryable: failure.retryable,
            cancelled,
            observedOutcome: cancelled ? 'cancelled' : 'run_loop_failed',
        },
    };
}
//# sourceMappingURL=failure-observation.js.map