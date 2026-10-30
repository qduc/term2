function isCostOnlyTrailer(chunk, isProviderTrailer) {
    if (!chunk || typeof chunk !== 'object')
        return false;
    const hasEmptyChoices = !chunk.choices || (Array.isArray(chunk.choices) && chunk.choices.length === 0);
    if (!hasEmptyChoices)
        return false;
    if (chunk.usage != null)
        return false;
    return typeof chunk.cost === 'string' || isProviderTrailer?.(chunk) === true;
}
function createNormalizedReasoningStream(stream, loggingService, costCapture, isProviderTrailer) {
    const iterator = stream[Symbol.asyncIterator]();
    return {
        [Symbol.asyncIterator]() {
            return {
                async next() {
                    let result = await iterator.next();
                    while (!result.done && isCostOnlyTrailer(result.value, isProviderTrailer)) {
                        // Intercept the provider-reported USD charge as billing metadata
                        // while keeping the trailer out of the SDK usage accumulator.
                        if (typeof result.value?.cost === 'string' && costCapture) {
                            costCapture.cost = result.value.cost;
                        }
                        if (loggingService) {
                            loggingService.debug('[COST_TRAILER] Captured provider cost-only trailer as billing metadata (kept out of SDK usage accumulator)');
                        }
                        result = await iterator.next();
                    }
                    if (!result.done && result.value?.choices) {
                        const choices = result.value.choices;
                        const hasMultipleChoices = choices.length > 1;
                        const hasNonZeroOrMissingIndex = choices.some((choice) => choice.index === undefined || choice.index !== 0);
                        if (hasMultipleChoices || hasNonZeroOrMissingIndex) {
                            const chunkStr = JSON.stringify(result.value, null, 2);
                            const msg = `[DEBUG_MALFORMED_RESPONSE] Intercepted malformed response chunk: ${chunkStr}`;
                            if (loggingService) {
                                loggingService.warn(msg);
                            }
                        }
                        if (choices.length === 1 && choices[0].index !== 0) {
                            choices[0].index = 0;
                        }
                    }
                    return result;
                },
            };
        },
    };
}
/**
 * Intercepts response stream metadata for OpenAI-compatible client calls.
 *
 * Wire fields (`reasoning_content` vs `reasoning`) are preserved verbatim.
 * Cost-only trailers are intercepted: the reported USD charge is captured into
 * `costCapture` (billing metadata) while the trailer itself is kept out of the
 * SDK usage accumulator.
 */
export function applyClientResponseNormalization(client, loggingService, costCapture, isProviderTrailer) {
    const originalCreate = client.chat.completions.create.bind(client.chat.completions);
    client.chat.completions.create = async (...args) => {
        if (costCapture)
            delete costCapture.cost;
        const result = await originalCreate(...args);
        if (!result || typeof result !== 'object')
            return result;
        if (Array.isArray(result.choices))
            return result;
        if (typeof result[Symbol.asyncIterator] === 'function') {
            return createNormalizedReasoningStream(result, loggingService, costCapture, isProviderTrailer);
        }
        return result;
    };
}
//# sourceMappingURL=openai-compatible-response-normalizer.js.map