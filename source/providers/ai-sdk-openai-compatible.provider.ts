import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { withMergedAssistantReasoning } from './ai-sdk-message-normalizer.js';

export type AiSdkOpenAICompatibleConfig = {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

export type AiSdkOpenAICompatibleProviderFactory = (options: {
  name: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  includeUsage?: boolean;
}) => (modelId: string) => any;

export class AiSdkOpenAICompatibleProvider implements ModelProvider {
  #label: string;
  #defaultModel: string;
  #resolveConfig: () => AiSdkOpenAICompatibleConfig;
  #createProvider: AiSdkOpenAICompatibleProviderFactory;

  constructor(deps: {
    label: string;
    defaultModel: string;
    resolveConfig: () => AiSdkOpenAICompatibleConfig;
    createProvider?: AiSdkOpenAICompatibleProviderFactory;
  }) {
    this.#label = deps.label;
    this.#defaultModel = deps.defaultModel;
    this.#resolveConfig = deps.resolveConfig;
    this.#createProvider = deps.createProvider ?? (createOpenAICompatible as AiSdkOpenAICompatibleProviderFactory);
  }

  getModel(modelName?: string): Promise<Model> | Model {
    const config = this.#resolveConfig();
    const provider = this.#createProvider({
      name: this.#label,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      headers: config.headers,
      includeUsage: true,
    });

    return aisdk(withMergedAssistantReasoning(provider(modelName || this.#defaultModel))) as unknown as Model;
  }
}
