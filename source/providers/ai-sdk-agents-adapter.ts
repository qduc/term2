import { aisdk, type AiSdkModelOptions } from '@openai/agents-extensions/ai-sdk';
import type { Model, ModelRequest } from '@openai/agents-core';
import { withMergedAssistantReasoning } from './ai-sdk-message-normalizer.js';

type LanguageModelCompatible = Parameters<typeof aisdk>[0];

function forwardReasoningSettings(request: ModelRequest): ModelRequest {
  const reasoning = request.modelSettings?.reasoning;
  if (!reasoning) {
    return request;
  }

  const providerData = request.modelSettings.providerData ?? {};
  if (providerData.reasoning) {
    return request;
  }

  return {
    ...request,
    modelSettings: {
      ...request.modelSettings,
      providerData: {
        ...providerData,
        reasoning,
      },
    },
  };
}

export function withForwardedReasoningSettings<T extends Model>(model: T): T {
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === 'getResponse') {
        return (request: ModelRequest) => target.getResponse(forwardReasoningSettings(request));
      }

      if (prop === 'getStreamedResponse') {
        return (request: ModelRequest) => target.getStreamedResponse(forwardReasoningSettings(request));
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function adaptAiSdkModelForAgents(model: LanguageModelCompatible, options?: AiSdkModelOptions): Model {
  const normalizedModel = withMergedAssistantReasoning(model);
  const agentsModel = aisdk(normalizedModel, options);
  return withForwardedReasoningSettings(agentsModel);
}
