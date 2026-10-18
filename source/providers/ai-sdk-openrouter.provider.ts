import { createOpenRouter, type OpenRouterProviderSettings } from '@openrouter/ai-sdk-provider';
import type { JSONValue, LanguageModelV3, LanguageModelV3CallOptions, SharedV3ProviderOptions } from '@ai-sdk/provider';
import { withForwardedProviderSettings } from './ai-sdk-provider-settings.js';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';

export type AiSdkOpenRouterConfig = Pick<
  OpenRouterProviderSettings,
  'baseURL' | 'apiKey' | 'headers' | 'appName' | 'appUrl' | 'fetch'
>;

export type AiSdkOpenRouterProviderFactory = (
  options: AiSdkOpenRouterConfig & { compatibility?: 'strict' | 'compatible' },
) => (modelId: string) => LanguageModelV3;

export class AiSdkOpenRouterProvider {
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

  getStreamedModel(modelName?: string): StreamedModelTurn {
    const config = this.#resolveConfig();
    const provider = this.#createProvider({
      ...config,
      compatibility: 'strict',
    });

    return createAiSdkStreamedModel(
      withForwardedProviderSettings(provider(modelName || this.#defaultModel), forwardOpenRouterSettings),
      resolveReasoningOptions,
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
function resolveReasoningOptions(request: StreamedModelTurnRequest): SharedV3ProviderOptions {
  const effort = request.reasoning?.effort;
  const providerOptions: SharedV3ProviderOptions = {
    ...(request.providerOptions as SharedV3ProviderOptions | undefined),
  };
  const existing = (providerOptions.openrouter as { reasoning?: JSONValue } | undefined)?.reasoning;
  if (existing || (effort && effort !== 'default')) {
    providerOptions.openrouter = {
      ...((providerOptions.openrouter ?? {}) as Record<string, JSONValue>),
      reasoning: existing ?? { effort },
    };
  }
  return providerOptions;
}
