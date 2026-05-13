import { Runner } from '@openai/agents';
import { OpenAIProvider } from '@openai/agents-openai';
import OpenAI from 'openai';
import type { ISettingsService } from '../services/service-interfaces.js';
import type { ProviderDefinition, ProviderDeps, ProviderFetch } from './registry.js';
import { AiSdkAnthropicProvider } from './ai-sdk-anthropic.provider.js';
import { AiSdkGoogleProvider } from './ai-sdk-google.provider.js';
import { createAiSdkLoggingFetch } from './ai-sdk-logging-fetch.js';
import { mergeAssistantMessages } from './ai-sdk-message-normalizer.js';
import { buildOpenAICompatibleUrl, normalizeBaseUrl } from './common/openai-compatible-utils.js';

export type CustomProviderConfig = {
  name: string;
  type?: string;
  baseUrl?: string;
  apiKey?: string;
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
};

const DEFAULT_ENV_API_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

export type CustomProviderRuntimeDeps = {
  defaultModel: string;
  fetch?: typeof fetch;
};

function applyLlamaCppReasoningControls(target: Record<string, any>, reasoningEffort: string | undefined): void {
  const budgets: Record<string, number> = {
    low: 1024,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
  };

  if (reasoningEffort === 'none' || reasoningEffort === 'minimal') {
    target.chat_template_kwargs = {
      reasoning_effort: 'low',
      enable_thinking: false,
      thinking_mode: 'disabled',
      reasoning_budget: 0,
    };
    return;
  }

  const templateEffort = reasoningEffort === 'xhigh' ? 'high' : reasoningEffort || 'medium';
  target.chat_template_kwargs = {
    reasoning_effort: templateEffort,
    enable_thinking: true,
    thinking_mode: templateEffort,
    reasoning_budget: budgets[reasoningEffort || 'medium'] ?? budgets.medium,
  };
}

function preserveReasoningContentForOpenAICompatibleMessages(messages: any[]): any[] {
  return messages.map((message) => {
    if (
      message?.role === 'assistant' &&
      typeof message.reasoning === 'string' &&
      typeof message.reasoning_content !== 'string'
    ) {
      return {
        ...message,
        reasoning_content: message.reasoning,
      };
    }

    return message;
  });
}

function normalizeMessageField(target: any): void {
  if (target && typeof target.reasoning_content === 'string' && typeof target.reasoning !== 'string') {
    target.reasoning = target.reasoning_content;
  }
}

/**
 * Normalizes `reasoning_content` → `reasoning` on responses from the OpenAI client,
 * after the HTTP response has been parsed. This is needed because the OpenAI Agents
 * SDK's `OpenAIChatCompletionsModel` checks for `reasoning` (not `reasoning_content`),
 * while many OpenAI-compatible providers return `reasoning_content` (the official
 * Chat Completions API field name).
 */
function applyClientResponseNormalization(client: OpenAI): void {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions) as (...args: any[]) => any;

  (client.chat.completions as any).create = async (...args: any[]) => {
    const result = await originalCreate(...args);

    if (!result || typeof result !== 'object') return result;

    if (Array.isArray(result.choices)) {
      // Non-streaming ChatCompletion
      for (const choice of result.choices) {
        normalizeMessageField(choice.message);
      }
      return result;
    }

    // Streaming (Stream<ChatCompletionChunk>)
    if (typeof result[Symbol.asyncIterator] === 'function') {
      return createNormalizedReasoningStream(result);
    }

    return result;
  };
}

function createNormalizedReasoningStream(stream: AsyncIterable<any>): AsyncIterable<any> {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value?.choices) {
            for (const choice of result.value.choices) {
              normalizeMessageField(choice.delta);
            }
          }
          return result;
        },
      };
    },
  };
}

function createOpenAICompatibleFetch(
  fetchImpl: typeof fetch | undefined,
  providerType: string,
): typeof fetch | undefined {
  if (!fetchImpl) return undefined;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        let changed = false;

        if (Array.isArray(body?.messages)) {
          body.messages = preserveReasoningContentForOpenAICompatibleMessages(mergeAssistantMessages(body.messages));
          changed = true;
        }

        const reasoningEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
        if (providerType === 'llama.cpp' && reasoningEffort) {
          delete body.reasoning_effort;
          applyLlamaCppReasoningControls(body, reasoningEffort);
          changed = true;
        }

        if (changed) {
          return fetchImpl(input, { ...init, body: JSON.stringify(body) });
        }
      } catch {
        return fetchImpl(input, init);
      }
    }

    return fetchImpl(input, init);
  }) as typeof fetch;
}

function findConfigFromSettings(settingsService: ISettingsService, providerId: string): CustomProviderConfig | null {
  const list = settingsService?.get?.('providers');
  if (!Array.isArray(list)) return null;
  const entry = list.find((p: any) => p && p.name === providerId);
  if (!entry) return null;

  return {
    name: String(entry.name),
    type: entry.type ? String(entry.type) : 'openai-compatible',
    baseUrl: entry.baseUrl ? String(entry.baseUrl) : undefined,
    apiKey: entry.apiKey ? String(entry.apiKey) : undefined,
  };
}

function toLabel(name: string): string {
  return name;
}

function getModelListItems(providerType: string | undefined, body: any): any[] {
  if (providerType === 'google') {
    return Array.isArray(body?.models) ? body.models : [];
  }

  return Array.isArray(body?.data) ? body.data : [];
}

function mapModelListItem(providerType: string | undefined, item: any): { id: string; name?: string } | null {
  if (providerType === 'google') {
    const id = item?.baseModelId || String(item?.name || '').replace(/^models\//, '');
    const name = item?.displayName || item?.description;
    return id ? { id, name } : null;
  }

  const id = item?.id || item?.model || '';
  const name = item?.name || item?.display_name || item?.description;
  return id ? { id, name } : null;
}

export function createCustomProviderModelProvider(
  config: CustomProviderConfig,
  deps: CustomProviderRuntimeDeps,
): OpenAIProvider | AiSdkAnthropicProvider | AiSdkGoogleProvider {
  const providerType = config.type || 'openai-compatible';
  const resolveConfig = () => ({
    baseURL: config.baseUrl ? normalizeBaseUrl(config.baseUrl) : undefined,
    apiKey: config.apiKey,
    fetch: deps.fetch,
    name: config.name,
  });

  switch (providerType) {
    case 'openai':
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseUrl ? normalizeBaseUrl(config.baseUrl) : undefined,
      });
    case 'anthropic':
      return new AiSdkAnthropicProvider({
        defaultModel: deps.defaultModel,
        resolveConfig: () => ({
          ...resolveConfig(),
          headers: {
            'anthropic-version': '2023-06-01',
          },
        }),
      });
    case 'google':
      return new AiSdkGoogleProvider({
        defaultModel: deps.defaultModel,
        resolveConfig,
      });
    case 'openai-compatible':
    case 'llama.cpp':
    default: {
      const openAIClient = new OpenAI({
        baseURL: normalizeBaseUrl(config.baseUrl ?? ''),
        apiKey: config.apiKey || 'no-key',
        fetch: createOpenAICompatibleFetch(deps.fetch, providerType) as any,
      });
      applyClientResponseNormalization(openAIClient);
      return new OpenAIProvider({
        openAIClient: openAIClient as any,
        useResponses: false,
      });
    }
  }
}

export function createOpenAICompatibleProviderDefinition(config: CustomProviderConfig): ProviderDefinition {
  const providerId = config.name;
  const label = toLabel(config.name);

  return {
    id: providerId,
    label,
    isRuntimeDefined: true,
    createRunner: ({ settingsService, loggingService }) => {
      // baseUrl/apiKey can change only with restart, but we re-resolve from
      // settings at runner creation time to respect precedence.
      return new Runner({
        modelProvider: (() => {
          const resolved = findConfigFromSettings(settingsService, providerId);
          if (!resolved) {
            throw new Error(
              `Custom provider '${providerId}' is not configured. ` +
                `Please add it to settings.json under \"providers\".`,
            );
          }

          return createCustomProviderModelProvider(resolved, {
            defaultModel: settingsService.get('agent.model') || '',
            fetch: createAiSdkLoggingFetch({
              provider: providerId,
              model: settingsService.get('agent.model') || '',
              loggingService,
            }),
          });
        })(),
      });
    },
    fetchModels: async (deps: ProviderDeps, fetchImpl: ProviderFetch = fetch as any) => {
      const resolved = findConfigFromSettings(deps.settingsService, providerId);
      if (!resolved) {
        throw new Error(`Custom provider '${providerId}' is not configured in settings.json`);
      }

      const effectiveBaseUrl = resolved.baseUrl ?? (resolved.type ? DEFAULT_BASE_URLS[resolved.type] : undefined);
      if (!effectiveBaseUrl) {
        throw new Error(`Custom provider '${providerId}' requires a baseUrl to list models`);
      }
      const baseUrl = normalizeBaseUrl(effectiveBaseUrl);
      const url = buildOpenAICompatibleUrl(baseUrl, '/models');

      const resolvedApiKey =
        resolved.apiKey ?? (resolved.type ? process.env[DEFAULT_ENV_API_KEYS[resolved.type] ?? ''] : undefined);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (resolved.type === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        if (resolvedApiKey) {
          headers['x-api-key'] = resolvedApiKey;
        }
      } else if (resolved.type === 'google') {
        if (resolvedApiKey) {
          headers['x-goog-api-key'] = resolvedApiKey;
        }
      } else if (resolvedApiKey) {
        headers.Authorization = `Bearer ${resolvedApiKey}`;
      }

      const response = await fetchImpl(url, { headers });
      if (!response.ok) {
        throw new Error(`${label} models request failed (${response.status})`);
      }

      const body = await response.json();
      const raw = getModelListItems(resolved.type, body);

      return raw.map((item: any) => mapModelListItem(resolved.type, item)).filter(Boolean) as Array<{
        id: string;
        name?: string;
      }>;
    },
    // apiKey is optional and may be stored in settings.json for local servers.
    sensitiveSettingKeys: [],
    capabilities: {
      supportsConversationChaining: false,
      supportsTracingControl: false,
    },
  };
}
