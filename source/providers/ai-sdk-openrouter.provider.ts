import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { createOpenRouter, type OpenRouterProviderSettings } from '@openrouter/ai-sdk-provider';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { withMergedAssistantReasoning } from './ai-sdk-message-normalizer.js';

export type AiSdkOpenRouterConfig = Pick<
  OpenRouterProviderSettings,
  'baseURL' | 'apiKey' | 'headers' | 'appName' | 'appUrl'
>;

export type AiSdkOpenRouterProviderFactory = (
  options: AiSdkOpenRouterConfig & { compatibility?: 'strict' | 'compatible' },
) => (modelId: string) => any;

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

    return aisdk(withMergedAssistantReasoning(provider(modelName || this.#defaultModel))) as unknown as Model;
  }
}
