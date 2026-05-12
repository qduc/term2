import { aisdk, type AiSdkModelOptions } from '@openai/agents-extensions/ai-sdk';
import type { Model, ModelRequest } from '@openai/agents-core';
import { withMergedAssistantReasoning } from './ai-sdk-message-normalizer.js';

type LanguageModelCompatible = Parameters<typeof aisdk>[0];

function getProviderOptionsKey(provider?: string): string | undefined {
  return provider?.split('.')[0] || undefined;
}

function getProviderDataOptions(providerData: Record<string, any>, providerOptionsKey: string): Record<string, any> {
  const { providerOptions: _providerOptions, ...extraBody } = providerData;

  return {
    ...extraBody,
    ...(providerData.providerOptions?.[providerOptionsKey] ?? {}),
  };
}

function getOpenRouterProviderOptions(providerData: Record<string, any>, reasoning: unknown): Record<string, any> {
  return {
    ...getProviderDataOptions(providerData, 'openrouter'),
    ...(providerData.reasoning || reasoning ? { reasoning: providerData.reasoning ?? reasoning } : {}),
  };
}

function forwardProviderSettings(
  request: ModelRequest,
  provider?: string,
  explicitProviderOptionsKey?: string,
): ModelRequest {
  const reasoning = request.modelSettings?.reasoning;
  const providerData = request.modelSettings.providerData ?? {};
  const providerOptionsKey = explicitProviderOptionsKey || getProviderOptionsKey(provider);
  const shouldForwardProviderData =
    Boolean(providerOptionsKey) && Object.keys(providerData).some((key) => key !== 'providerOptions');

  if (!reasoning && !shouldForwardProviderData) {
    return request;
  }

  const providerOptions =
    shouldForwardProviderData && providerOptionsKey
      ? {
          ...(providerData.providerOptions ?? {}),
          [providerOptionsKey]:
            providerOptionsKey === 'openrouter'
              ? getOpenRouterProviderOptions(providerData, reasoning)
              : getProviderDataOptions(providerData, providerOptionsKey),
        }
      : providerData.providerOptions;

  if (providerData.reasoning) {
    return providerOptions === providerData.providerOptions
      ? request
      : {
          ...request,
          modelSettings: {
            ...request.modelSettings,
            providerData: {
              ...providerData,
              providerOptions,
            },
          },
        };
  }

  return {
    ...request,
    modelSettings: {
      ...request.modelSettings,
      providerData: {
        ...providerData,
        ...(reasoning ? { reasoning } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      },
    },
  };
}

export function withForwardedReasoningSettings<T extends Model>(
  model: T,
  provider?: string,
  providerOptionsKey?: string,
): T {
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === 'getResponse') {
        return (request: ModelRequest) =>
          target.getResponse(forwardProviderSettings(request, provider, providerOptionsKey));
      }

      if (prop === 'getStreamedResponse') {
        return (request: ModelRequest) =>
          target.getStreamedResponse(forwardProviderSettings(request, provider, providerOptionsKey));
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function adaptAiSdkModelForAgents(
  model: LanguageModelCompatible,
  options?: AiSdkModelOptions,
  providerOptionsKey?: string,
): Model {
  const normalizedModel = withMergedAssistantReasoning(model);
  const agentsModel = aisdk(normalizedModel, options);
  return withForwardedReasoningSettings(agentsModel, model.provider, providerOptionsKey);
}
