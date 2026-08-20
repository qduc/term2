import OpenAI from 'openai';
import type { ISettingsService, ILoggingService, ISessionContextService } from '../services/service-interfaces.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import { type ProviderDefinition, type ProviderDeps, type ProviderFetch } from './registry.js';
import { AiSdkAnthropicProvider } from './ai-sdk-anthropic.provider.js';
import { AiSdkGoogleProvider } from './ai-sdk-google.provider.js';
import { createProviderFetch } from './fetch/composer.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { buildOpenAICompatibleUrl, normalizeBaseUrl } from './common/openai-compatible-utils.js';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';
import { isOpencodeProvider, resolveOpencodeRuntimeConfig } from './opencode.provider.js';
import { resolveProviderCredentialValue } from '../utils/ai/provider-credentials.js';
import { generateOpencodeSessionId } from './opencode-session.js';
import {
  findKnownOpencodeModelTransport,
  selectOpencodeModelTransport,
  shouldApplyOpencodeAnthropicPromptCaching,
} from './opencode-routing.js';
import { CachedOpencodeTransportDiscovery, type OpencodeTransportDiscovery } from './opencode-transport-discovery.js';
import { createAnthropicMiddleware } from './anthropic-middleware.js';
import {
  createOpenAICompatibleMiddleware,
  createOpenAIResponsesMiddleware,
  sanitizeResponsesApiBody,
} from './openai-compatible-middleware.js';
import { applyClientResponseNormalization, type CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import { getModelListItems, mapModelListItem } from './openai-compatible-models.js';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';
import { OpenAIResponsesModelWithPromptCacheKey } from './openai-responses-model.js';
import {
  decodeStoredCustomProviderConfigs,
  normalizeProviderIdentifier,
} from '../services/settings/custom-provider-normalization.js';

export type CustomProviderConfig = {
  name: string;
  label?: string;
  type?: string;
  baseUrl?: string;
  apiKey?: string;
};

// The tag carried on `provider_opaque` items so a later turn can prove the
// continuity metadata it is about to splice came from *this* endpoint. It must
// identify the configured provider, not its type: two providers of type
// `openai-compatible` — a deepseek endpoint and an OpenRouter gateway — spell
// reasoning differently, and tagging both `openai-compatible` would let one's
// fields be replayed into the other's request. `config.name` is already the
// provider's identity elsewhere (see createOpenAICompatibleProviderDefinition).
export const opaqueProviderTag = (config: CustomProviderConfig): string =>
  config.name || config.type || 'openai-compatible';

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
  /** Resolves unknown Zen model IDs from the cached official endpoint table. */
  opencodeTransportDiscovery?: OpencodeTransportDiscovery;
};

function findConfigFromSettings(settingsService: ISettingsService, providerId: string): CustomProviderConfig | null {
  const raw: unknown = settingsService?.getDynamic('providers');
  const configs = decodeStoredCustomProviderConfigs(raw);
  const normalizedProviderId = normalizeProviderIdentifier(providerId);
  const entry =
    configs.find((p) => p.id === providerId || p.name === providerId) ??
    configs.find((p) => p.id === normalizedProviderId || p.name === normalizedProviderId);
  if (!entry) return null;

  return {
    name: entry.id,
    label: entry.name,
    type: entry.type,
    baseUrl: entry.baseUrl,
    apiKey: resolveProviderCredentialValue(settingsService, providerId),
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
    defaultModel: (deps.defaultModel || '').trim(),
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

export class OpencodeAnthropicFormatProvider {
  private readonly fallbackSessionId: string | undefined;
  private readonly transportDiscovery: OpencodeTransportDiscovery;

  constructor(private readonly config: CustomProviderConfig, private readonly deps: CustomProviderRuntimeDeps) {
    const isOpencode = isOpencodeProvider(this.config);
    // The streamed provider factory may recreate this wrapper for each turn.
    // Derive its fallback from the active conversation so recreation preserves
    // the OpenCode session without sharing identity across conversations.
    const conversationSessionId = this.deps.sessionContextService?.getContext()?.sessionId;
    this.fallbackSessionId = isOpencode ? generateOpencodeSessionId(conversationSessionId) : undefined;
    this.transportDiscovery =
      this.deps.opencodeTransportDiscovery ?? new CachedOpencodeTransportDiscovery({ fetchImpl: this.deps.fetch });
  }

  private resolveRuntimeConfig(): { baseUrl: string; apiKey: string | undefined } {
    return isOpencodeProvider(this.config)
      ? resolveOpencodeRuntimeConfig(this.config.baseUrl, this.config.apiKey)
      : { baseUrl: this.config.baseUrl ?? '', apiKey: this.config.apiKey };
  }

  private buildAnthropicStreamedModel(
    resolvedModel: string,
    runtimeConfig: { baseUrl: string; apiKey: string | undefined },
  ): StreamedModelTurn {
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
        headers: { 'anthropic-version': '2023-06-01' },
      }),
    });
    return anthropicProvider.getStreamedModel(resolvedModel);
  }

  private buildOpenAIResponsesModel(
    resolvedModel: string,
    runtimeConfig: { baseUrl: string; apiKey: string | undefined },
  ): StreamedModelTurn {
    const openAIClient = new OpenAI({
      baseURL: normalizeBaseUrl(runtimeConfig.baseUrl),
      apiKey: runtimeConfig.apiKey || 'no-key',
      maxRetries: this.deps.settingsService?.get('agent.retryAttempts') ?? 2,
      fetch: buildProviderFetch(this.config, this.deps, [
        createOpenAIResponsesMiddleware(this.config.type || 'opencode', runtimeConfig.baseUrl, {
          sessionContextService: this.deps.sessionContextService,
          fallbackSessionIdOverride: this.fallbackSessionId,
        }),
      ]),
    });
    return new OpenAIResponsesModelWithPromptCacheKey(openAIClient, resolvedModel);
  }

  private buildOpenAICompatibleModel(
    resolvedModel: string,
    runtimeConfig: { baseUrl: string; apiKey: string | undefined },
  ): StreamedModelTurn {
    const openAIClient = new OpenAI({
      baseURL: normalizeBaseUrl(runtimeConfig.baseUrl),
      apiKey: runtimeConfig.apiKey || 'no-key',
      maxRetries: this.deps.settingsService?.get('agent.retryAttempts') ?? 2,
      fetch: buildProviderFetch(this.config, this.deps, [
        createOpenAICompatibleMiddleware(this.config.type || 'opencode', runtimeConfig.baseUrl, {
          sessionContextService: this.deps.sessionContextService,
          fallbackSessionIdOverride: this.fallbackSessionId,
        }),
      ]),
    });
    const costCapture: CostTrailerCapture = {};
    applyClientResponseNormalization(openAIClient, this.deps.loggingService, costCapture);
    return new OpenAIChatCompletionsModel(openAIClient, resolvedModel, costCapture, opaqueProviderTag(this.config));
  }

  getStreamedModel(modelName?: string): StreamedModelTurn {
    const resolvedModel = (modelName || this.deps.defaultModel || '').trim();
    const runtimeConfig = this.resolveRuntimeConfig();
    const knownTransport = findKnownOpencodeModelTransport(resolvedModel);
    if (knownTransport) return this.buildForTransport(knownTransport, resolvedModel, runtimeConfig);

    if (!isOpencodeZenBaseUrl(runtimeConfig.baseUrl)) {
      return this.buildOpenAICompatibleModel(resolvedModel, runtimeConfig);
    }

    return deferredOpencodeTransportModel(
      async (signal) =>
        (await this.transportDiscovery.resolve(resolvedModel, signal)) ?? selectOpencodeModelTransport(resolvedModel),
      (transport) => this.buildForTransport(transport, resolvedModel, runtimeConfig),
    );
  }

  private buildForTransport(
    transport: ReturnType<typeof selectOpencodeModelTransport>,
    resolvedModel: string,
    runtimeConfig: { baseUrl: string; apiKey: string | undefined },
  ): StreamedModelTurn {
    switch (transport) {
      case 'anthropic-messages':
        return this.buildAnthropicStreamedModel(resolvedModel, runtimeConfig);
      case 'openai-responses':
        return this.buildOpenAIResponsesModel(resolvedModel, runtimeConfig);
      case 'openai-chat-completions':
        return this.buildOpenAICompatibleModel(resolvedModel, runtimeConfig);
    }
  }
}

function deferredOpencodeTransportModel(
  resolveTransport: (signal: AbortSignal | undefined) => Promise<ReturnType<typeof selectOpencodeModelTransport>>,
  buildModel: (transport: ReturnType<typeof selectOpencodeModelTransport>) => StreamedModelTurn,
): StreamedModelTurn {
  return {
    async *stream(request: StreamedModelTurnRequest) {
      const model = buildModel(await resolveTransport(request.signal));
      yield* model.stream(request);
    },
  };
}

function isOpencodeZenBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'opencode.ai' && url.pathname.startsWith('/zen/');
  } catch {
    return false;
  }
}

export function createCustomProviderModelProvider(config: CustomProviderConfig, deps: CustomProviderRuntimeDeps): any {
  const normalizedDeps = { ...deps, defaultModel: (deps.defaultModel || '').trim() };
  const providerType = config.type || 'openai-compatible';
  const resolveConfig = () => ({
    baseURL: config.baseUrl ? normalizeBaseUrl(config.baseUrl) : undefined,
    apiKey: config.apiKey,
    fetch: normalizedDeps.fetch,
    name: config.name,
  });

  switch (providerType) {
    case 'openai': {
      const openAIClient = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl ? normalizeBaseUrl(config.baseUrl) : undefined,
        maxRetries: normalizedDeps.settingsService?.get('agent.retryAttempts') ?? 2,
        fetch: buildProviderFetch(config, normalizedDeps, [createOpenAIResponsesMiddleware()]),
      });
      return new OpenAIChatCompletionsModel(
        openAIClient,
        normalizedDeps.defaultModel,
        undefined,
        opaqueProviderTag(config),
      );
    }
    case 'anthropic':
      return new AiSdkAnthropicProvider({
        defaultModel: normalizedDeps.defaultModel,
        resolveConfig: () => ({
          ...resolveConfig(),
          fetch: buildProviderFetch(config, normalizedDeps, [
            createAnthropicMiddleware(config.type || 'anthropic', config.baseUrl, {
              sessionContextService: normalizedDeps.sessionContextService,
            }),
          ]),
          headers: {
            'anthropic-version': '2023-06-01',
          },
        }),
      });
    case 'google':
      return new AiSdkGoogleProvider({
        defaultModel: normalizedDeps.defaultModel,
        resolveConfig: () => ({
          ...resolveConfig(),
          fetch: buildProviderFetch(config, normalizedDeps, []),
        }),
      });
    case 'opencode':
      return new OpencodeAnthropicFormatProvider(config, normalizedDeps);
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
        maxRetries: normalizedDeps.settingsService?.get('agent.retryAttempts') ?? 2,
        fetch: buildProviderFetch(config, normalizedDeps, [
          createOpenAICompatibleMiddleware(providerType, runtimeConfig.baseUrl, {
            sessionContextService: normalizedDeps.sessionContextService,
          }),
        ]),
      });
      const costCapture: CostTrailerCapture = {};
      applyClientResponseNormalization(openAIClient, normalizedDeps.loggingService, costCapture);
      return new OpenAIChatCompletionsModel(
        openAIClient,
        normalizedDeps.defaultModel,
        costCapture,
        opaqueProviderTag(config),
      );
    }
  }
}

export function createOpenAICompatibleProviderDefinition(config: CustomProviderConfig): ProviderDefinition {
  const providerId = config.name;
  const label = toLabel(config.label ?? config.name);

  return {
    id: providerId,
    label,
    isRuntimeDefined: true,
    createStreamedModel: (model, deps) => {
      const resolved = findConfigFromSettings(deps.settingsService, providerId);
      if (!resolved) {
        throw new Error(`Custom provider '${providerId}' is not configured in settings.json`);
      }
      const provider = createCustomProviderModelProvider(resolved, {
        defaultModel: model,
        loggingService: deps.loggingService,
        sessionContextService: deps.sessionContextService,
        settingsService: deps.settingsService,
      });
      if (!('getStreamedModel' in provider) || typeof provider.getStreamedModel !== 'function') {
        throw new Error(`Custom provider '${providerId}' has no application-owned streamed model`);
      }
      return provider.getStreamedModel(model);
    },
    fetchModels: async (deps: ProviderDeps, fetchImpl: ProviderFetch = fetch) => {
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
    },
  };
}
