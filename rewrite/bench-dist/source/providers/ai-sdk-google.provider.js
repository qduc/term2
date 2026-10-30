import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { forwardExplicitProviderSettings, withForwardedProviderSettings, resolveThinkingBudget, } from './ai-sdk-provider-settings.js';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';
export class AiSdkGoogleProvider {
    #defaultModel;
    #resolveConfig;
    #createProvider;
    constructor(deps) {
        this.#defaultModel = deps.defaultModel;
        this.#resolveConfig = deps.resolveConfig;
        this.#createProvider = deps.createProvider ?? createGoogleGenerativeAI;
    }
    getStreamedModel(modelName) {
        const config = this.#resolveConfig();
        const provider = this.#createProvider(config);
        return createAiSdkStreamedModel(withFallbackResponseId(withForwardedProviderSettings(provider(modelName || this.#defaultModel), (options) => forwardExplicitProviderSettings(options, 'google'))), resolveReasoningOptions);
    }
}
/** Google Generative AI streams may omit response metadata; retain the legacy adapter's fallback id locally. */
function withFallbackResponseId(model) {
    return new Proxy(model, {
        get(target, property, receiver) {
            if (property === 'doStream') {
                return async (options) => {
                    const result = await target.doStream(options);
                    return { ...result, stream: withResponseId(result.stream) };
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
async function* withResponseId(stream) {
    yield { type: 'response-metadata', id: 'FAKE_ID' };
    yield* stream;
}
/** Apply google's reasoning options before crossing the SDK boundary. */
function resolveReasoningOptions(request) {
    const budget = resolveThinkingBudget(request.reasoning?.effort);
    if (budget === undefined)
        return request.providerOptions;
    const providerOptions = {
        ...request.providerOptions,
    };
    providerOptions.google = {
        ...(providerOptions.google ?? {}),
        thinkingConfig: providerOptions.google?.thinkingConfig ?? { thinkingBudget: budget, includeThoughts: true },
    };
    return providerOptions;
}
//# sourceMappingURL=ai-sdk-google.provider.js.map