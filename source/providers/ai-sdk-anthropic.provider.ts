import { createAnthropic, type AnthropicProviderSettings } from '@ai-sdk/anthropic';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { adaptAiSdkModelForAgents } from './ai-sdk-agents-adapter.js';

export type AiSdkAnthropicConfig = Pick<
  AnthropicProviderSettings,
  'baseURL' | 'apiKey' | 'authToken' | 'headers' | 'fetch' | 'name'
>;

export type AiSdkAnthropicProviderFactory = (options: AiSdkAnthropicConfig) => (modelId: string) => any;

export class AiSdkAnthropicProvider implements ModelProvider {
  #defaultModel: string;
  #resolveConfig: () => AiSdkAnthropicConfig;
  #createProvider: AiSdkAnthropicProviderFactory;

  constructor(deps: {
    defaultModel: string;
    resolveConfig: () => AiSdkAnthropicConfig;
    createProvider?: AiSdkAnthropicProviderFactory;
  }) {
    this.#defaultModel = deps.defaultModel;
    this.#resolveConfig = deps.resolveConfig;
    this.#createProvider = deps.createProvider ?? (createAnthropic as AiSdkAnthropicProviderFactory);
  }

  getModel(modelName?: string): Promise<Model> | Model {
    const config = this.#resolveConfig();
    const provider = this.#createProvider(config);

    return adaptAiSdkModelForAgents(provider(modelName || this.#defaultModel), undefined, 'anthropic');
  }
}
