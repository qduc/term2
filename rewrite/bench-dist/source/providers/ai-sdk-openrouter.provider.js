import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { withForwardedProviderSettings } from './ai-sdk-provider-settings.js';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';
export class AiSdkOpenRouterProvider {
    #defaultModel;
    #resolveConfig;
    #createProvider;
    constructor(deps) {
        this.#defaultModel = deps.defaultModel;
        this.#resolveConfig = deps.resolveConfig;
        this.#createProvider = deps.createProvider ?? createOpenRouter;
    }
    getStreamedModel(modelName) {
        const config = this.#resolveConfig();
        const provider = this.#createProvider({
            ...config,
            compatibility: 'strict',
        });
        return createAiSdkStreamedModel(withForwardedProviderSettings(provider(modelName || this.#defaultModel), forwardOpenRouterSettings), resolveReasoningOptions);
    }
}
function forwardOpenRouterSettings(options) {
    const providerData = options.providerOptions;
    if (!providerData || typeof providerData !== 'object')
        return options;
    const { providerOptions, openrouter: directOpenrouter, reasoning: providerReasoning, ...extraBody } = providerData;
    if (!Object.keys(extraBody).length && !providerReasoning && !directOpenrouter) {
        return providerOptions ? { ...options, providerOptions } : options;
    }
    return {
        ...options,
        ...extraBody,
        providerOptions: {
            ...(providerOptions ?? {}),
            openrouter: {
                ...extraBody,
                ...(directOpenrouter ?? {}),
                ...(providerOptions?.openrouter ?? {}),
                ...(providerReasoning || options.reasoning ? { reasoning: providerReasoning ?? options.reasoning } : {}),
            },
        },
    };
}
/** Preserve explicit OpenRouter reasoning configuration before applying the chosen effort. */
function resolveReasoningOptions(request) {
    const effort = request.reasoning?.effort;
    const providerOptions = {
        ...request.providerOptions,
    };
    const existing = providerOptions.openrouter?.reasoning;
    if (existing || (effort && effort !== 'default')) {
        providerOptions.openrouter = {
            ...(providerOptions.openrouter ?? {}),
            reasoning: existing ?? { effort },
        };
    }
    return providerOptions;
}
//# sourceMappingURL=ai-sdk-openrouter.provider.js.map