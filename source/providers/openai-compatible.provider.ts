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
  baseUrl: string;
  apiKey?: string;
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

function mirrorReasoningContent(target: any): boolean {
  if (target && typeof target.reasoning_content === 'string' && typeof target.reasoning !== 'string') {
    target.reasoning = target.reasoning_content;
    return true;
  }

  return false;
}

function normalizeOpenAICompatibleResponseBody(body: any): boolean {
  if (!Array.isArray(body?.choices)) {
    return false;
  }

  let changed = false;
  for (const choice of body.choices) {
    changed = mirrorReasoningContent(choice?.message) || changed;
    changed = mirrorReasoningContent(choice?.delta) || changed;
  }

  return changed;
}

function responseHeadersWithoutContentLength(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete('content-length');
  return next;
}

async function normalizeOpenAICompatibleJsonResponse(response: Response): Promise<Response> {
  let text = '';
  try {
    text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!normalizeOpenAICompatibleResponseBody(body)) {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersWithoutContentLength(response.headers),
    });
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersWithoutContentLength(response.headers),
    });
  }
}

function normalizeOpenAICompatibleSseLine(line: string): string {
  if (!line.startsWith('data:')) {
    return line;
  }

  const data = line.slice(5).trimStart();
  if (!data || data === '[DONE]') {
    return line;
  }

  try {
    const body = JSON.parse(data);
    if (!normalizeOpenAICompatibleResponseBody(body)) {
      return line;
    }
    return `data: ${JSON.stringify(body)}`;
  } catch {
    return line;
  }
}

function normalizeOpenAICompatibleSseResponse(response: Response): Response {
  if (!response.body) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';

  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });

        const parts = buffered.split(/(\r?\n)/);
        buffered = parts.pop() ?? '';

        for (let i = 0; i < parts.length; i += 2) {
          const line = parts[i] ?? '';
          const newline = parts[i + 1] ?? '';
          controller.enqueue(encoder.encode(`${normalizeOpenAICompatibleSseLine(line)}${newline}`));
        }
      },
      flush(controller) {
        buffered += decoder.decode();
        if (buffered) {
          controller.enqueue(encoder.encode(normalizeOpenAICompatibleSseLine(buffered)));
        }
      },
    }),
  );

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeadersWithoutContentLength(response.headers),
  });
}

async function normalizeOpenAICompatibleResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return normalizeOpenAICompatibleSseResponse(response);
  }

  if (contentType.includes('application/json')) {
    return normalizeOpenAICompatibleJsonResponse(response);
  }

  return response;
}

function createOpenAICompatibleFetch(
  fetchImpl: typeof fetch | undefined,
  providerType: string,
): typeof fetch | undefined {
  if (!fetchImpl) return undefined;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let nextInit = init;

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
          nextInit = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        nextInit = init;
      }
    }

    return normalizeOpenAICompatibleResponse(await fetchImpl(input, nextInit));
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
    baseUrl: String(entry.baseUrl),
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
    baseURL: normalizeBaseUrl(config.baseUrl),
    apiKey: config.apiKey,
    fetch: deps.fetch,
    name: config.name,
  });

  switch (providerType) {
    case 'openai':
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: normalizeBaseUrl(config.baseUrl),
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
        baseURL: normalizeBaseUrl(config.baseUrl),
        apiKey: config.apiKey || 'no-key',
        fetch: createOpenAICompatibleFetch(deps.fetch, providerType) as any,
      });
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

      const baseUrl = normalizeBaseUrl(resolved.baseUrl);
      const url = buildOpenAICompatibleUrl(baseUrl, '/models');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (resolved.type === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        if (resolved.apiKey) {
          headers['x-api-key'] = resolved.apiKey;
        }
      } else if (resolved.type === 'google') {
        if (resolved.apiKey) {
          headers['x-goog-api-key'] = resolved.apiKey;
        }
      } else if (resolved.apiKey) {
        headers.Authorization = `Bearer ${resolved.apiKey}`;
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
