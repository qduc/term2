import { createGoogleGenerativeAI, type GoogleGenerativeAIProviderSettings } from '@ai-sdk/google';
import type { LanguageModelV3, LanguageModelV3CallOptions, SharedV3ProviderOptions } from '@ai-sdk/provider';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { adaptStreamedModelTurnForAgents } from './agents-model-bridge.js';
import { withForwardedProviderSettings } from './ai-sdk-provider-settings.js';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';

export type AiSdkGoogleConfig = Pick<
  GoogleGenerativeAIProviderSettings,
  'baseURL' | 'apiKey' | 'headers' | 'fetch' | 'name'
>;

export type AiSdkGoogleProviderFactory = (options: AiSdkGoogleConfig) => (modelId: string) => LanguageModelV3;

export class AiSdkGoogleProvider implements ModelProvider {
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

  getModel(modelName?: string): Promise<Model> | Model {
    const config = this.#resolveConfig();
    const provider = this.#createProvider(config);

    return adaptStreamedModelTurnForAgents(
      createAiSdkStreamedModel(
        withFallbackResponseId(
          withForwardedProviderSettings(provider(modelName || this.#defaultModel), forwardGoogleSettings),
        ),
      ),
    );
  }
}

/** Retains the legacy adapter's explicit `google` provider-data convention at the provider boundary. */
function forwardGoogleSettings(options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
  const providerData = options.providerOptions as GoogleProviderData | undefined;
  if (!providerData || typeof providerData !== 'object') return options;

  const { providerOptions, ...extraProviderData } = providerData;
  if (!Object.keys(extraProviderData).length) return providerOptions ? { ...options, providerOptions } : options;

  return {
    ...options,
    ...extraProviderData,
    providerOptions: {
      ...(providerOptions ?? {}),
      google: {
        ...extraProviderData,
        ...(providerOptions?.google ?? {}),
      },
    },
  };
}

type GoogleProviderData = SharedV3ProviderOptions & {
  providerOptions?: SharedV3ProviderOptions;
};

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
