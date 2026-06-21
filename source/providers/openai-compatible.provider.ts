import { Runner } from '@openai/agents';
import { OpenAIProvider } from '@openai/agents-openai';
import OpenAI from 'openai';
import type { ISettingsService, ILoggingService, ISessionContextService } from '../services/service-interfaces.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import type { ProviderDefinition, ProviderDeps, ProviderFetch } from './registry.js';
import { AiSdkAnthropicProvider } from './ai-sdk-anthropic.provider.js';
import { AiSdkGoogleProvider } from './ai-sdk-google.provider.js';
import { createProviderFetch } from './fetch/composer.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { buildOpenAICompatibleUrl, normalizeBaseUrl } from './common/openai-compatible-utils.js';
import { type ModelProvider, type Model } from '@openai/agents-core';
import { isOpencodeProvider, resolveOpencodeRuntimeConfig } from './opencode.provider.js';
import { generateOpencodeSessionId } from './opencode-session.js';
import { selectOpencodeModelTransport, shouldApplyOpencodeAnthropicPromptCaching } from './opencode-routing.js';
import { createAnthropicMiddleware } from './anthropic-middleware.js';
import {
  createOpenAICompatibleMiddleware,
  createOpenAIResponsesMiddleware,
  sanitizeResponsesApiBody,
} from './openai-compatible-middleware.js';
import { applyClientResponseNormalization } from './openai-compatible-response-normalizer.js';
import { getModelListItems, mapModelListItem } from './openai-compatible-models.js';

export type CustomProviderConfig = {
  name: string;
  type?: string;
  baseUrl?: string;
  apiKey?: string;
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  opencode: 'https://opencode.ai/v1',
};

const DEFAULT_ENV_API_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
};

export type CustomProviderRuntimeDeps = {
  defaultModel: string;
  fetch?: typeof fetch;
  loggingService?: ILoggingService;
  sessionContextService?: ISessionContextService;
  settingsService?: ISettingsService;
};

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

export { sanitizeResponsesApiBody };

function buildProviderFetch(
  config: CustomProviderConfig,
  deps: CustomProviderRuntimeDeps,
  middlewares: FetchMiddleware[],
): typeof fetch {
  const sessionContextService = deps.sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE;
  return createProviderFetch({
    providerId: config.name,
    defaultModel: deps.defaultModel,
    deps: {
      loggingService:
        deps.loggingService ||
        ({
          debug: () => {},
          error: () => {},
          getCorrelationId: () => undefined,
          info: () => {},
          warn: () => {},
          security: () => {},
          setCorrelationId: () => {},
          clearCorrelationId: () => {},
        } as ILoggingService),
      sessionContextService,
    },
    middlewares,
    fetchImpl: deps.fetch,
  });
}

export class OpencodeAnthropicFormatProvider implements ModelProvider {
  private readonly fallbackSessionId: string | undefined;
  private readonly models = new Map<string, Model | Promise<Model>>();

  constructor(private readonly config: CustomProviderConfig, private readonly deps: CustomProviderRuntimeDeps) {
    const isOpencode = isOpencodeProvider(this.config);
    this.fallbackSessionId = isOpencode ? generateOpencodeSessionId() : undefined;
  }

  private resolveRuntimeConfig(): { baseUrl: string; apiKey: string | undefined } {
    return isOpencodeProvider(this.config)
      ? resolveOpencodeRuntimeConfig(this.config.baseUrl, this.config.apiKey)
      : { baseUrl: this.config.baseUrl ?? '', apiKey: this.config.apiKey };
  }

  private buildAnthropicModel(resolvedModel: string, runtimeConfig: { baseUrl: string; apiKey: string | undefined }) {
    const anthropicProvider = new AiSdkAnthropicProvider({
      defaultModel: resolvedModel,
      shouldApplyPromptCaching: shouldApplyOpencodeAnthropicPromptCaching,
      resolveConfig: () => ({
        baseURL: runtimeConfig.baseUrl ? normalizeBaseUrl(runtimeConfig.baseUrl) : undefined,
        apiKey: runtimeConfig.apiKey,
        fetch: buildProviderFetch(this.config, this.deps, [
          createAnthropicMiddleware(this.config.type || 'opencode', runtimeConfig.baseUrl, {
            sessionContextService: this.deps.sessionContextService,
            fallbackSessionIdOverride: this.fallbackSessionId,
          }),
        ]),
        name: this.config.name,
        headers: {
          'anthropic-version': '2023-06-01',
        },
      }),
    });
    return anthropicProvider.getModel(resolvedModel);
  }

  private buildOpenAICompatibleModel(
    resolvedModel: string,
    runtimeConfig: { baseUrl: string; apiKey: string | undefined },
  ) {
    const openAIClient = new OpenAI({
      baseURL: normalizeBaseUrl(runtimeConfig.baseUrl),
      apiKey: runtimeConfig.apiKey || 'no-key',
      maxRetries: this.deps.settingsService?.get<number>('agent.retryAttempts') ?? 2,
      fetch: buildProviderFetch(this.config, this.deps, [
        createOpenAICompatibleMiddleware(this.config.type || 'opencode', runtimeConfig.baseUrl, {
          sessionContextService: this.deps.sessionContextService,
          fallbackSessionIdOverride: this.fallbackSessionId,
        }),
      ]) as any,
    });
    applyClientResponseNormalization(openAIClient, this.deps.loggingService);
    const openaiProvider = new OpenAIProvider({
      openAIClient: openAIClient as any,
      useResponses: false,
    });
    return openaiProvider.getModel(resolvedModel);
  }

  getModel(modelName?: string): Promise<Model> | Model {
    const resolvedModel = modelName || this.deps.defaultModel || '';
    const cached = this.models.get(resolvedModel);
    if (cached) {
      return cached;
    }

    const runtimeConfig = this.resolveRuntimeConfig();
    const model =
      selectOpencodeModelTransport(resolvedModel) === 'anthropic-messages'
        ? this.buildAnthropicModel(resolvedModel, runtimeConfig)
        : this.buildOpenAICompatibleModel(resolvedModel, runtimeConfig);
    this.models.set(resolvedModel, model);
    return model;
  }
}

export function createCustomProviderModelProvider(
  config: CustomProviderConfig,
  deps: CustomProviderRuntimeDeps,
): OpenAIProvider | AiSdkAnthropicProvider | AiSdkGoogleProvider | OpencodeAnthropicFormatProvider {
  const providerType = config.type || 'openai-compatible';
  const resolveConfig = () => ({
    baseURL: config.baseUrl ? normalizeBaseUrl(config.baseUrl) : undefined,
    apiKey: config.apiKey,
    fetch: deps.fetch,
    name: config.name,
  });

  switch (providerType) {
    case 'openai': {
      const openAIClient = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl ? normalizeBaseUrl(config.baseUrl) : undefined,
        maxRetries: deps.settingsService?.get<number>('agent.retryAttempts') ?? 2,
        fetch: buildProviderFetch(config, deps, [createOpenAIResponsesMiddleware()]) as any,
      });
      return new OpenAIProvider({
        openAIClient: openAIClient as any,
        useResponses: true,
      });
    }
    case 'anthropic':
      return new AiSdkAnthropicProvider({
        defaultModel: deps.defaultModel,
        resolveConfig: () => ({
          ...resolveConfig(),
          fetch: buildProviderFetch(config, deps, [
            createAnthropicMiddleware(config.type || 'anthropic', config.baseUrl, {
              sessionContextService: deps.sessionContextService,
            }),
          ]),
          headers: {
            'anthropic-version': '2023-06-01',
          },
        }),
      });
    case 'google':
      return new AiSdkGoogleProvider({
        defaultModel: deps.defaultModel,
        resolveConfig: () => ({
          ...resolveConfig(),
          fetch: buildProviderFetch(config, deps, []),
        }),
      });
    case 'opencode':
      return new OpencodeAnthropicFormatProvider(config, deps);
    case 'openai-compatible':
    case 'llama.cpp':
    default: {
      const isOpencode = isOpencodeProvider({ type: providerType, name: config.name, baseUrl: config.baseUrl });
      const runtimeConfig = isOpencode
        ? resolveOpencodeRuntimeConfig(config.baseUrl, config.apiKey)
        : { baseUrl: config.baseUrl ?? '', apiKey: config.apiKey };

      const openAIClient = new OpenAI({
        baseURL: normalizeBaseUrl(runtimeConfig.baseUrl),
        apiKey: runtimeConfig.apiKey || 'no-key',
        maxRetries: deps.settingsService?.get<number>('agent.retryAttempts') ?? 2,
        fetch: buildProviderFetch(config, deps, [
          createOpenAICompatibleMiddleware(providerType, runtimeConfig.baseUrl, {
            sessionContextService: deps.sessionContextService,
          }),
        ]) as any,
      });
      applyClientResponseNormalization(openAIClient, deps.loggingService);
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
    createRunner: ({ settingsService, loggingService, sessionContextService }) => {
      // baseUrl/apiKey can change only with restart, but we re-resolve from
      // settings at runner creation time to respect precedence.
      return new Runner({
        tracingDisabled: true,
        modelProvider: (() => {
          const resolved = findConfigFromSettings(settingsService, providerId);
          if (!resolved) {
            throw new Error(
              `Custom provider '${providerId}' is not configured. ` +
                `Please add it to settings.json under "providers".`,
            );
          }

          return createCustomProviderModelProvider(resolved, {
            defaultModel: settingsService.get('agent.model') || '',
            loggingService,
            sessionContextService,
            settingsService,
          });
        })(),
      });
    },
    fetchModels: async (deps: ProviderDeps, fetchImpl: ProviderFetch = fetch as any) => {
      const resolved = findConfigFromSettings(deps.settingsService, providerId);
      if (!resolved) {
        throw new Error(`Custom provider '${providerId}' is not configured in settings.json`);
      }

      const isOpencode = isOpencodeProvider(resolved);

      const effectiveBaseUrl =
        resolved.baseUrl ??
        (resolved.type ? DEFAULT_BASE_URLS[resolved.type] : undefined) ??
        (isOpencode ? resolveOpencodeRuntimeConfig().baseUrl : undefined);

      if (!effectiveBaseUrl) {
        throw new Error(`Custom provider '${providerId}' requires a baseUrl to list models`);
      }
      const baseUrl = normalizeBaseUrl(effectiveBaseUrl);
      let url = buildOpenAICompatibleUrl(baseUrl, '/models');

      const resolvedApiKey =
        resolved.apiKey ??
        (resolved.type ? process.env[DEFAULT_ENV_API_KEYS[resolved.type] ?? ''] : undefined) ??
        (isOpencode ? resolveOpencodeRuntimeConfig().apiKey : undefined);

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
          url = `${url}${url.includes('?') ? '&' : '?'}key=${resolvedApiKey}`;
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
