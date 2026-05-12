import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { adaptAiSdkModelForAgents } from './ai-sdk-agents-adapter.js';

export type AiSdkOpenAICompatibleConfig = {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
};

export type AiSdkOpenAICompatibleProviderFactory = (options: {
  name: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  includeUsage?: boolean;
  fetch?: typeof fetch;
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
      fetch: config.fetch,
    });

    return adaptAiSdkModelForAgents(provider(modelName || this.#defaultModel));
  }
}
