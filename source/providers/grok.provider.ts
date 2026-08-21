import OpenAI from 'openai';
import os from 'node:os';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { injectHeaders, installationVersion } from './fetch/logging-middleware.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import type { ISessionContextService } from '../services/service-interfaces.js';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';
import { applyClientResponseNormalization, type CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import { RetryingModel } from './retrying-model.js';
import { GrokTokenManager } from './grok-auth.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';

/**
 * Grok subscription access goes through the CLI chat proxy, not the metered
 * public xAI API: an OAuth access token is only accepted here. The proxy speaks
 * OpenAI chat completions.
 */
export const GROK_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const DEFAULT_GROK_MODEL = 'grok-4.6';

/**
 * The proxy hard-rejects requests whose client version it does not recognise
 * (HTTP 426), so this header is required, not cosmetic. Raise it when the proxy
 * starts refusing this floor.
 */
export const GROK_CLIENT_VERSION = '1.0.5';

const GROK_CAPABILITIES = {
  supportsConversationChaining: false,
  supportsContextCompaction: false,
  supportsPromptCacheKey: false,
  usesStrictToolSchema: false,
} as const;

function grokAuthMiddleware(
  tokenManager: GrokTokenManager,
  loggingService: { error: (msg: string, meta?: any) => void },
): FetchMiddleware {
  return async (ctx, next) => {
    try {
      const accessToken = await tokenManager.getOrRefreshAccessToken();
      const headers = injectHeaders(ctx.init?.headers, { Authorization: `Bearer ${accessToken}` });
      return next({ url: ctx.url, init: { ...ctx.init, headers } });
    } catch (err: any) {
      loggingService.error('Grok OAuth fetch interceptor error', { error: err?.message });
      throw err;
    }
  };
}

function grokHeadersMiddleware(sessionContextService?: ISessionContextService): FetchMiddleware {
  return (ctx, next) => {
    const sessionId = sessionContextService?.getContext()?.sessionId;
    const headers = injectHeaders(ctx.init?.headers, {
      'x-grok-client-version': GROK_CLIENT_VERSION,
      'x-grok-client-identifier': 'term2',
      'User-Agent': `term2/${installationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`,
      // xAI pins a conversation to one server by this header, and prompt-cache
      // entries live per server. Their caching docs say to always set it; the
      // undocumented `x-grok-session-id` we used to send bought no affinity.
      ...(sessionId ? { 'x-grok-conv-id': sessionId, 'x-grok-session-id': sessionId } : {}),
    });
    return next({ url: ctx.url, init: { ...ctx.init, headers } });
  };
}

export function buildGrokFetch(deps: ProviderDeps, tokenManager: GrokTokenManager, defaultModel: string): typeof fetch {
  return createProviderFetch({
    providerId: 'grok',
    defaultModel,
    deps: {
      loggingService: deps.loggingService,
      sessionContextService: deps.sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE,
    },
    middlewares: [
      grokAuthMiddleware(tokenManager, deps.loggingService),
      grokHeadersMiddleware(deps.sessionContextService),
    ],
  });
}

export async function fetchGrokModels(
  deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch,
): Promise<Array<{ id: string; name?: string; default_reasoning_level?: string }>> {
  const tokenManager = new GrokTokenManager({ fetchImpl });
  const accessToken = await tokenManager.getOrRefreshAccessToken();

  const response = await fetchImpl(`${GROK_BASE_URL}/models`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-grok-client-version': GROK_CLIENT_VERSION,
      'x-grok-client-identifier': 'term2',
    },
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Grok models request failed (${response.status})`);
  }

  const body = await response.json();
  const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return raw
    .map((item: any) => {
      const id = item?.id || item?.model || '';
      return id
        ? {
            id,
            name: item?.name || item?.display_name,
            default_reasoning_level: item?.reasoning_effort,
          }
        : null;
    })
    .filter(Boolean) as Array<{ id: string; name?: string; default_reasoning_level?: string }>;
}

export function createGrokStreamedModel(model: string, deps: ProviderDeps): StreamedModelTurn {
  const resolvedModel = (model || deps.settingsService.get('agent.model') || DEFAULT_GROK_MODEL).trim();
  const retryAttempts = deps.retryAttempts ?? deps.settingsService.get('agent.retryAttempts') ?? 2;

  const openAIClient = new OpenAI({
    apiKey: 'oauth',
    baseURL: process.env.GROK_BASE_URL || GROK_BASE_URL,
    maxRetries: retryAttempts,
    fetch: buildGrokFetch(deps, new GrokTokenManager(), resolvedModel),
  });

  const costCapture: CostTrailerCapture = {};
  applyClientResponseNormalization(openAIClient, deps.loggingService, costCapture);

  return new RetryingModel(new OpenAIChatCompletionsModel(openAIClient, resolvedModel, costCapture, 'grok'), {
    retryAttempts,
    loggingService: deps.loggingService,
    onRetry: deps.onRetry,
  });
}

registerProvider({
  id: 'grok',
  label: 'Grok',
  createStreamedModel: createGrokStreamedModel,
  fetchModels: fetchGrokModels,
  sensitiveSettingKeys: [],
  capabilities: GROK_CAPABILITIES,
});
