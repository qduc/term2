import { createAnthropic, type AnthropicProviderSettings } from '@ai-sdk/anthropic';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { adaptAiSdkModelForAgents } from './ai-sdk-agents-adapter.js';

type AiSdkAnthropicModelLike = {
  doGenerate: (options: any) => PromiseLike<any> | any;
  doStream: (options: any) => PromiseLike<any> | any;
};

function isAnthropicModel(modelId: string): boolean {
  const lowerModelId = modelId.toLowerCase();
  return lowerModelId.includes('anthropic') || lowerModelId.includes('claude');
}

export function addAnthropicPromptCachingToMessages(messages: any[], modelId?: string): any[] {
  if (!Array.isArray(messages) || messages.length === 0 || !modelId || !isAnthropicModel(modelId)) {
    return messages;
  }

  const next = messages.map((message) => ({ ...message }));

  const markMessage = (index: number): void => {
    const message = next[index];
    if (!message) return;

    message.providerOptions = {
      ...message.providerOptions,
      anthropic: {
        ...(message.providerOptions?.anthropic ?? {}),
        cacheControl: { type: 'ephemeral' },
      },
    };
  };

  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'system') {
      markMessage(i);
      break;
    }
  }

  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'user') {
      markMessage(i);
      break;
    }
  }

  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'tool') {
      markMessage(i);
      break;
    }
  }

  return next;
}

const anthropicPromptCachingMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: ({ params, model }: any): any => {
    const input = params as any;
    if (!Array.isArray(input?.messages) && !Array.isArray(input?.prompt)) {
      return input;
    }

    const modelId = typeof model === 'string' ? model : model?.modelId;

    return {
      ...input,
      ...(Array.isArray(input.messages)
        ? { messages: addAnthropicPromptCachingToMessages(input.messages, modelId) }
        : {}),
      ...(Array.isArray(input.prompt) ? { prompt: addAnthropicPromptCachingToMessages(input.prompt, modelId) } : {}),
    };
  },
};

function withAnthropicPromptCaching<T extends AiSdkAnthropicModelLike>(model: T): T {
  return wrapLanguageModel({
    model: model as any,
    middleware: anthropicPromptCachingMiddleware,
  }) as unknown as T;
}

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
    const model = withAnthropicPromptCaching(provider(modelName || this.#defaultModel));

    return adaptAiSdkModelForAgents(model, undefined, 'anthropic');
  }
}
