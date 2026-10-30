import { createAnthropic } from '@ai-sdk/anthropic';
import { wrapLanguageModel } from 'ai';
import { forwardExplicitProviderSettings, withForwardedProviderSettings, resolveThinkingBudget, } from './ai-sdk-provider-settings.js';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';
function defaultAnthropicPromptCachingPredicate(modelId) {
    const lowerModelId = modelId.toLowerCase();
    return lowerModelId.includes('anthropic') || lowerModelId.includes('claude');
}
export function addAnthropicPromptCachingToMessages(messages, modelId, shouldApplyPromptCaching = defaultAnthropicPromptCachingPredicate) {
    if (!Array.isArray(messages) || messages.length === 0 || !modelId || !shouldApplyPromptCaching(modelId)) {
        return messages;
    }
    const next = messages.map((message) => ({ ...message }));
    const markMessage = (index) => {
        const message = next[index];
        if (!message)
            return;
        message.providerOptions = {
            ...message.providerOptions,
            anthropic: {
                ...(message.providerOptions?.anthropic ?? {}),
                cacheControl: { type: 'ephemeral' },
            },
        };
    };
    for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === 'system') {
            markMessage(i);
            break;
        }
    }
    for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === 'user') {
            markMessage(i);
            break;
        }
    }
    for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === 'tool') {
            markMessage(i);
            break;
        }
    }
    return next;
}
function createAnthropicPromptCachingMiddleware(shouldApplyPromptCaching) {
    return {
        specificationVersion: 'v3',
        transformParams: ({ params, model }) => {
            const input = params;
            if (!Array.isArray(input?.messages) && !Array.isArray(input?.prompt)) {
                return input;
            }
            const modelId = typeof model === 'string' ? model : model?.modelId;
            return {
                ...input,
                ...(Array.isArray(input.messages)
                    ? { messages: addAnthropicPromptCachingToMessages(input.messages, modelId, shouldApplyPromptCaching) }
                    : {}),
                ...(Array.isArray(input.prompt)
                    ? { prompt: addAnthropicPromptCachingToMessages(input.prompt, modelId, shouldApplyPromptCaching) }
                    : {}),
            };
        },
    };
}
const MAX_OUTPUT_TOKENS_MAP = {
    'minimax-m3': 131072,
    'qwen3.5-plus': 65536,
    'mimo-v2-omni': 128000,
    'kimi-k2.6': 65536,
    'qwen3.7-max': 65536,
    'qwen3.6-plus': 65536,
    'minimax-m2.7': 131072,
    'deepseek-v4-flash': 384000,
    'glm-5': 32768,
    'minimax-m2.5': 65536,
    'mimo-v2-pro': 128000,
    'qwen3.7-plus': 65536,
    'mimo-v2.5': 128000,
    'deepseek-v4-pro': 384000,
    'kimi-k2.5': 65536,
    'glm-5.1': 32768,
    'mimo-v2.5-pro': 128000,
};
export function getMaxOutputTokens(modelId) {
    const defaultLimit = 65536;
    if (!modelId)
        return defaultLimit;
    const key = modelId.split('/').pop()?.toLowerCase() ?? '';
    return MAX_OUTPUT_TOKENS_MAP[key] ?? defaultLimit;
}
function withAnthropicPromptCaching(model, shouldApplyPromptCaching, modelId) {
    const maxOutputTokens = getMaxOutputTokens(modelId);
    return wrapLanguageModel({
        model: model,
        middleware: [
            {
                specificationVersion: 'v3',
                // The catalog value is a safety ceiling, not an instruction to expand
                // an explicit caller limit. Preserve a lower requested limit and cap an
                // excessive request to the model's known maximum.
                transformParams: async ({ params }) => ({
                    ...params,
                    maxOutputTokens: params.maxOutputTokens === undefined ? maxOutputTokens : Math.min(params.maxOutputTokens, maxOutputTokens),
                }),
            },
            createAnthropicPromptCachingMiddleware(shouldApplyPromptCaching),
        ],
    });
}
export class AiSdkAnthropicProvider {
    #defaultModel;
    #resolveConfig;
    #createProvider;
    #shouldApplyPromptCaching;
    constructor(deps) {
        this.#defaultModel = deps.defaultModel;
        this.#resolveConfig = deps.resolveConfig;
        this.#createProvider = deps.createProvider ?? createAnthropic;
        this.#shouldApplyPromptCaching = deps.shouldApplyPromptCaching ?? defaultAnthropicPromptCachingPredicate;
    }
    getStreamedModel(modelName) {
        const config = this.#resolveConfig();
        const provider = this.#createProvider(config);
        const resolvedModelName = modelName || this.#defaultModel;
        const model = withAnthropicPromptCaching(provider(resolvedModelName), this.#shouldApplyPromptCaching, resolvedModelName);
        return createAiSdkStreamedModel(withForwardedProviderSettings(model, (options) => forwardExplicitProviderSettings(options, 'anthropic')), resolveReasoningOptions);
    }
}
/** Apply anthropic's reasoning options before crossing the SDK boundary. */
function resolveReasoningOptions(request) {
    const budget = resolveThinkingBudget(request.reasoning?.effort);
    if (budget === undefined)
        return request.providerOptions;
    const providerOptions = {
        ...request.providerOptions,
    };
    providerOptions.anthropic = {
        ...(providerOptions.anthropic ?? {}),
        thinking: providerOptions.anthropic?.thinking ?? { type: 'enabled', budgetTokens: budget },
    };
    return providerOptions;
}
//# sourceMappingURL=ai-sdk-anthropic.provider.js.map