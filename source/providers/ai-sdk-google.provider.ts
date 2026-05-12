import { createGoogleGenerativeAI, type GoogleGenerativeAIProviderSettings } from '@ai-sdk/google';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { adaptAiSdkModelForAgents } from './ai-sdk-agents-adapter.js';

export type AiSdkGoogleConfig = Pick<
  GoogleGenerativeAIProviderSettings,
  'baseURL' | 'apiKey' | 'headers' | 'fetch' | 'name'
>;

export type AiSdkGoogleProviderFactory = (options: AiSdkGoogleConfig) => (modelId: string) => any;

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

    return adaptAiSdkModelForAgents(provider(modelName || this.#defaultModel), undefined, 'google');
  }
}
