import OpenAI from 'openai';
import { RetryingModel } from './retrying-model.js';
import type { ISettingsService } from '../services/service-interfaces.js';
import { type ProviderDefinition, type ProviderDeps, type ProviderFetch } from './registry.js';
import { AiSdkAnthropicProvider } from './ai-sdk-anthropic.provider.js';
import { AiSdkGoogleProvider } from './ai-sdk-google.provider.js';
import { buildOpenAICompatibleUrl, normalizeBaseUrl } from './common/openai-compatible-utils.js';
import { isOpencodeProvider, isOpencodeTrailer, resolveOpencodeRuntimeConfig } from './opencode.provider.js';
import { resolveProviderCredentialValue } from '../utils/ai/provider-credentials.js';
import { OpencodeAnthropicFormatProvider } from './opencode-model-provider.js';
import { createOpencodeSessionMiddleware } from './opencode-middleware.js';
import { createAnthropicChatCachingMiddleware } from './anthropic-chat-caching.js';
import { createLlamaCppMiddleware } from './llama-cpp.provider.js';
import {
  buildProviderFetch,
  type CustomProviderConfig,
  type CustomProviderRuntimeDeps,
} from './custom-provider-runtime.js';
export type { CustomProviderConfig, CustomProviderRuntimeDeps } from './custom-provider-runtime.js';
import {
  createOpenAICompatibleMiddleware,
  createOpenAIResponsesMiddleware,
  sanitizeResponsesApiBody,
} from './openai-compatible-middleware.js';
import { applyClientResponseNormalization, type CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import { getModelListItems, mapModelListItem } from './openai-compatible-models.js';
import { neuralwattDefaultReasoningLevel } from './neuralwatt.provider.js';
import { isOrcaRouterBaseUrl, parseOrcaRouterModels } from './orcarouter-models.js';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';
import {
  decodeStoredCustomProviderConfigs,
  normalizeProviderIdentifier,
} from '../services/settings/custom-provider-normalization.js';

// The tag carried on `provider_opaque` items so a later turn can prove the
// continuity metadata it is about to splice came from *this* endpoint. It must
// identify the configured provider, not its type: two providers of type
// `openai-compatible` — a deepseek endpoint and an OpenRouter gateway — spell
// reasoning differently, and tagging both `openai-compatible` would let one's
// fields be replayed into the other's request. `config.name` is already the
// provider's identity elsewhere (see createOpenAICompatibleProviderDefinition).
const opaqueProviderTag = (config: CustomProviderConfig): string => config.name || config.type || 'openai-compatible';

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
            createOpencodeSessionMiddleware(
              { type: config.type || 'anthropic', baseUrl: config.baseUrl },
              {
                sessionContextService: normalizedDeps.sessionContextService,
              },
            ),
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
          createOpenAICompatibleMiddleware(),
          createAnthropicChatCachingMiddleware(),
          createLlamaCppMiddleware(providerType),
          createOpencodeSessionMiddleware(
            { type: providerType, baseUrl: runtimeConfig.baseUrl },
            {
              sessionContextService: normalizedDeps.sessionContextService,
            },
          ),
        ]),
      });
      const costCapture: CostTrailerCapture = {};
      applyClientResponseNormalization(
        openAIClient,
        normalizedDeps.loggingService,
        costCapture,
        isOpencode ? isOpencodeTrailer : undefined,
      );
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
    defaultReasoningLevel: neuralwattDefaultReasoningLevel(providerId),
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
      const streamed = provider.getStreamedModel(model);
      const attempts = deps.retryAttempts ?? deps.settingsService.get('agent.retryAttempts') ?? 2;
      return new RetryingModel(streamed, {
        retryAttempts: attempts,
        loggingService: deps.loggingService,
        onRetry: deps.onRetry,
      });
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
      if (isOrcaRouterBaseUrl(baseUrl)) {
        return parseOrcaRouterModels(resolved.type, body);
      }
      const raw = getModelListItems(resolved.type, body);
      // Some gateways answer routing errors with HTTP 200 and an error body
      // (e.g. Z.ai: {"code":500,"msg":"404 NOT_FOUND"}). Surface that as a
      // fetch failure instead of reporting a silently empty model catalog.
      if (raw === null) {
        const listField = resolved.type === 'google' ? 'models' : 'data';
        const bodyPreview = typeof body === 'string' ? body : JSON.stringify(body) ?? '';
        throw new Error(
          `${label} models listing response was not recognized (expected a JSON object with a '${listField}' array)` +
            (bodyPreview ? `: ${bodyPreview.slice(0, 120)}` : ''),
        );
      }

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
