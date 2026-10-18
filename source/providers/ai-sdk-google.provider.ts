import type { SharedV3ProviderOptions } from '@ai-sdk/provider';
import { createGoogleGenerativeAI, type GoogleGenerativeAIProviderSettings } from '@ai-sdk/google';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import {
  forwardExplicitProviderSettings,
  withForwardedProviderSettings,
  resolveThinkingBudget,
} from './ai-sdk-provider-settings.js';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';

export type AiSdkGoogleConfig = Pick<
  GoogleGenerativeAIProviderSettings,
  'baseURL' | 'apiKey' | 'headers' | 'fetch' | 'name'
>;

export type AiSdkGoogleProviderFactory = (options: AiSdkGoogleConfig) => (modelId: string) => LanguageModelV3;

export class AiSdkGoogleProvider {
  #defaultModel: string;
  #resolveConfig: () => AiSdkGoogleConfig;
  #createProvider: AiSdkGoogleProviderFactory;

  constructor(deps: {
    defaultModel: string;
    resolveConfig: () => AiSdkGoogleConfig;
    createProvider?: AiSdkGoogleProviderFactory;
  }) {
    this.#defaultModel = deps.defaultModel;
    this.#resolveConfig = deps.resolveConfig;
    this.#createProvider = deps.createProvider ?? (createGoogleGenerativeAI as AiSdkGoogleProviderFactory);
  }

  getStreamedModel(modelName?: string): StreamedModelTurn {
    const config = this.#resolveConfig();
    const provider = this.#createProvider(config);

    return createAiSdkStreamedModel(
      withFallbackResponseId(
        withForwardedProviderSettings(provider(modelName || this.#defaultModel), (options) =>
          forwardExplicitProviderSettings(options, 'google'),
        ),
      ),
      resolveReasoningOptions,
    );
  }
}

/** Google Generative AI streams may omit response metadata; retain the legacy adapter's fallback id locally. */
function withFallbackResponseId(model: LanguageModelV3): LanguageModelV3 {
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doStream') {
        return async (options: LanguageModelV3CallOptions) => {
          const result = await target.doStream(options);
          return { ...result, stream: withResponseId(result.stream) };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function* withResponseId(stream: Awaited<ReturnType<LanguageModelV3['doStream']>>['stream']) {
  yield { type: 'response-metadata' as const, id: 'FAKE_ID' };
  yield* stream;
}

/** Apply google's reasoning options before crossing the SDK boundary. */
function resolveReasoningOptions(request: StreamedModelTurnRequest): SharedV3ProviderOptions | undefined {
  const budget = resolveThinkingBudget(request.reasoning?.effort);
  if (budget === undefined) return request.providerOptions as SharedV3ProviderOptions | undefined;
  const providerOptions: SharedV3ProviderOptions = {
    ...(request.providerOptions as SharedV3ProviderOptions | undefined),
  };
  providerOptions.google = {
    ...(providerOptions.google ?? {}),
    thinkingConfig: providerOptions.google?.thinkingConfig ?? { thinkingBudget: budget, includeThoughts: true },
  };
  return providerOptions;
}
