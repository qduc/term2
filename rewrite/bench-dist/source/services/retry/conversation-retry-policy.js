import { isModelBehaviorError } from '../../contracts/model-errors.js';
export { isTransientRetryableError } from './retry-error-classification.js';
export const MAX_HALLUCINATION_RETRIES = 2;
export const MAX_SUBAGENT_MODEL_RETRIES = 2;
export const isRecoverableModelError = (error) => {
    if (!isModelBehaviorError(error)) {
        return false;
    }
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return ((message.includes('tool') && message.includes('not found')) ||
        message.includes('model did not produce a final response') ||
        message.includes('parsing tool arguments') ||
        message.includes('valid json'));
};
/**
 * Decides whether a model error is recoverable and returns retry metadata only.
 * Useful for callers (e.g. subagent manager) that need retry classification
 * without parent-specific fields like hadStream or nextRunOptions.
 */
export const decideRecoverableModelRetry = (error, attemptCount, maxRetries = MAX_HALLUCINATION_RETRIES) => {
    if (!isRecoverableModelError(error) || attemptCount >= maxRetries) {
        return { kind: 'no_retry' };
    }
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const isHallucination = lower.includes('not found');
    const isParsingError = lower.includes('parsing tool arguments') || lower.includes('valid json');
    const toolName = isHallucination ? message.match(/Tool (\S+) not found/)?.[1] || 'unknown' : 'unknown';
    const retryType = isHallucination ? 'hallucination' : isParsingError ? 'parsing_error' : 'behavior';
    return {
        kind: 'retry',
        message,
        toolName,
        retryType,
        attempt: attemptCount + 1,
        maxRetries,
    };
};
export const decideRetry = (error, attemptCount, hadStream, streamHistoryLength, maxRetries = MAX_HALLUCINATION_RETRIES) => {
    const decision = decideRecoverableModelRetry(error, attemptCount, maxRetries);
    if (decision.kind === 'no_retry') {
        return { kind: 'no_retry' };
    }
    const { message, toolName, retryType, attempt } = decision;
    return {
        kind: 'retry',
        message,
        retryEvent: {
            type: 'retry',
            toolName: retryType === 'hallucination' ? toolName : 'model',
            attempt,
            maxRetries,
            errorMessage: message,
            retryType,
        },
        logPayload: {
            toolName,
            retryType,
            attempt,
            maxRetries,
            errorMessage: message,
        },
        attempt,
        hadStream,
        shouldInjectErrorContext: hadStream && streamHistoryLength === 0,
        errorContextMessage: `[System: Previous attempt failed with error: ${message}. Please retry with corrected output.]`,
        nextRunOptions: {
            retries: { hallucinationRetryCount: attempt },
            skipUserMessage: hadStream,
        },
    };
};
//# sourceMappingURL=conversation-retry-policy.js.map