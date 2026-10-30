import OpenAI from 'openai';
import { OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey, } from './openai-responses-model.js';
import { registerProvider } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
const streamedModels = new WeakMap();
function openaiStreamedModelFingerprint(settingsService, model, retryAttempts) {
    return JSON.stringify([
        settingsService.get('agent.transport') ?? 'websocket',
        model,
        retryAttempts ?? settingsService.get('agent.retryAttempts') ?? 2,
    ]);
}
export { OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey, } from './openai-responses-model.js';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const OPENAI_CAPABILITIES = {
    supportsFlexServiceTier: true,
    supportsConversationChaining: true,
    supportsContextCompaction: true,
    supportsPromptCacheKey: true,
    promptCacheKeyPlacement: 'responses-extra-body',
    usesStrictToolSchema: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
};
/**
 * Observe retries at the SDK transport boundary. OpenAI's fetch hook sees the
 * response before the SDK decides whether to retry, so response status alone
 * cannot distinguish a retryable final response from one followed by another
 * attempt. The SDK does expose its attempt number in this request header;
 * callback at the start of attempt N>0, where the next retry is actually
 * being dispatched. This also covers transport failures and emits nothing for
 * exhausted attempt N=0.
 */
export function createRetryAwareFetch(baseFetch, onRetry, retryAttempts) {
    if (!onRetry || retryAttempts <= 0)
        return baseFetch;
    return (async (url, init) => {
        const headers = init?.headers;
        const rawRetryCount = typeof headers?.get === 'function'
            ? headers.get('x-stainless-retry-count')
            : headers?.['x-stainless-retry-count'] ?? headers?.['X-Stainless-Retry-Count'];
        const retryCount = Number(rawRetryCount);
        if (Number.isInteger(retryCount) && retryCount > 0)
            onRetry();
        return baseFetch(url, init);
    });
}
async function fetchOpenAIModels(deps, fetchImpl = fetch) {
    const headers = {
        'Content-Type': 'application/json',
    };
    const apiKey = deps.settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetchImpl(OPENAI_MODELS_URL, { headers, ...(deps.signal ? { signal: deps.signal } : {}) });
    if (!response.ok) {
        throw new Error(`OpenAI models request failed (${response.status})`);
    }
    const body = await response.json();
    const raw = body?.data || [];
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((item) => {
        const id = item?.id || item?.model || '';
        const name = item?.name || item?.display_name || item?.description;
        return id ? { id, name } : null;
    })
        .filter(Boolean)
        .reverse();
}
// Register OpenAI provider
registerProvider({
    id: 'openai',
    label: 'OpenAI',
    createStreamedModel: (model, { settingsService, loggingService, sessionContextService, onRetry, retryAttempts, requestCapture, contextCompactionSessionState, }) => {
        const defaultModel = settingsService.get('agent.modelSelection').model || 'gpt-4o';
        const resolvedModel = model || defaultModel;
        const cacheKey = sessionContextService;
        const fingerprint = openaiStreamedModelFingerprint(settingsService, resolvedModel, retryAttempts);
        const cached = cacheKey ? streamedModels.get(cacheKey) : undefined;
        if (cached?.fingerprint === fingerprint) {
            return cached.model;
        }
        if (cached) {
            void cached.model.close?.();
        }
        const apiKey = settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
        const configuredRetries = retryAttempts ?? settingsService.get('agent.retryAttempts') ?? 2;
        const openAIClient = new OpenAI({
            apiKey: apiKey || 'placeholder',
            maxRetries: configuredRetries,
            fetch: createRetryAwareFetch(createProviderFetch({
                providerId: 'openai',
                defaultModel,
                deps: { loggingService, sessionContextService: sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE },
            }), onRetry, configuredRetries),
        });
        const selectedModel = settingsService.get('agent.transport') === 'http'
            ? new OpenAIResponsesModelWithPromptCacheKey(openAIClient, resolvedModel, requestCapture, OPENAI_CAPABILITIES.supportsContextCompaction, contextCompactionSessionState)
            : new OpenAIResponsesWSModelWithPromptCacheKey(openAIClient, resolvedModel, requestCapture, OPENAI_CAPABILITIES.supportsContextCompaction, contextCompactionSessionState);
        if (cacheKey)
            streamedModels.set(cacheKey, { fingerprint, model: selectedModel });
        return selectedModel;
    },
    fetchModels: fetchOpenAIModels,
    clearConversations: undefined, // No conversation state to clear
    sensitiveSettingKeys: [],
    capabilities: OPENAI_CAPABILITIES,
}, { builtin: true });
//# sourceMappingURL=openai.provider.js.map