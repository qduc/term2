import { createOpenRouter, type OpenRouterProviderSettings } from '@openrouter/ai-sdk-provider';
import type { JSONValue, LanguageModelV3, LanguageModelV3CallOptions, SharedV3ProviderOptions } from '@ai-sdk/provider';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { adaptStreamedModelTurnForAgents } from './agents-model-bridge.js';
import { withForwardedProviderSettings } from './ai-sdk-provider-settings.js';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';

export type AiSdkOpenRouterConfig = Pick<
  OpenRouterProviderSettings,
  'baseURL' | 'apiKey' | 'headers' | 'appName' | 'appUrl' | 'fetch'
>;

export type AiSdkOpenRouterProviderFactory = (
  options: AiSdkOpenRouterConfig & { compatibility?: 'strict' | 'compatible' },
) => (modelId: string) => LanguageModelV3;

export class AiSdkOpenRouterProvider implements ModelProvider {
  #defaultModel: string;
  #resolveConfig: () => AiSdkOpenRouterConfig;
  #createProvider: AiSdkOpenRouterProviderFactory;

  constructor(deps: {
    defaultModel: string;
    resolveConfig: () => AiSdkOpenRouterConfig;
    createProvider?: AiSdkOpenRouterProviderFactory;
  }) {
    this.#defaultModel = deps.defaultModel;
    this.#resolveConfig = deps.resolveConfig;
    this.#createProvider = deps.createProvider ?? (createOpenRouter as AiSdkOpenRouterProviderFactory);
  }

  getModel(modelName?: string): Promise<Model> | Model {
    const config = this.#resolveConfig();
    const provider = this.#createProvider({
      ...config,
      compatibility: 'strict',
    });

    return adaptStreamedModelTurnForAgents(
      createAiSdkStreamedModel(
        withForwardedProviderSettings(provider(modelName || this.#defaultModel), forwardOpenRouterSettings),
      ),
    );
  }
}

type OpenRouterCallOptions = LanguageModelV3CallOptions & {
  reasoning?: JSONValue;
  providerOptions?: SharedV3ProviderOptions & {
    providerOptions?: SharedV3ProviderOptions;
    reasoning?: JSONValue;
  };
};

function forwardOpenRouterSettings(options: OpenRouterCallOptions): OpenRouterCallOptions {
  const providerData = options.providerOptions;
  if (!providerData || typeof providerData !== 'object') return options;

  const { providerOptions, reasoning: providerReasoning, ...extraBody } = providerData;
  if (!Object.keys(extraBody).length && !providerReasoning) {
    return providerOptions ? { ...options, providerOptions } : options;
  }

  return {
    ...options,
    ...extraBody,
    providerOptions: {
      ...(providerOptions ?? {}),
      openrouter: {
        ...extraBody,
        ...(providerOptions?.openrouter ?? {}),
        ...(providerReasoning || options.reasoning ? { reasoning: providerReasoning ?? options.reasoning } : {}),
      },
    },
  };
}
