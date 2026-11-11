import { RetryingModel } from './retrying-model.js';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { addCacheControlToLastTwoMessages } from './anthropic-chat-caching.js';
import type { CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../traffic-context.js';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../streamed-model-turn.js';

async function createOpenRouterModel(deps: ProviderDeps, model: string): Promise<StreamedModelTurn | null> {
  const { settingsService, loggingService, sessionContextService } = deps;
  const apiKey = settingsService.get('agent.openrouter.apiKey') || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  // Loaded with the first model rather than at startup, like the other chat-completions providers.
  const [
    { default: OpenAI },
    { OpenAIChatCompletionsModel },
    { applyClientResponseNormalization },
    { createOpenAICompatibleMiddleware },
  ] = await Promise.all([
    import('openai'),
    import('./openai-chat-completions-model.js'),
    import('./openai-compatible-response-normalizer.js'),
    import('./openai-compatible-middleware.js'),
  ]);
  const referrer = settingsService.get('agent.openrouter.referrer') || 'https://github.com/qduc/term2';
  const title = settingsService.get('agent.openrouter.title') || 'term2';
  const client = new OpenAI({
    baseURL: settingsService.get('agent.openrouter.baseUrl') || 'https://openrouter.ai/api/v1',
    apiKey,
    // The caller owns retries (RetryingModel below, or the engine). A second
    // retry loop inside the client would multiply attempts and hide them.
    maxRetries: 0,
    defaultHeaders: { 'HTTP-Referer': referrer, 'X-Title': title, 'X-OpenRouter-Title': title },
    fetch: createProviderFetch({
      providerId: 'openrouter',
      defaultModel: settingsService.get('agent.modelSelection').model || model,
      deps: {
        loggingService,
        sessionContextService: sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE,
        onDispatched: deps.onDispatched,
      },
      middlewares: [createOpenAICompatibleMiddleware(), openRouterPreprocessingMiddleware],
    }),
  });
  const costCapture: CostTrailerCapture = {};
  applyClientResponseNormalization(client, loggingService, costCapture);
  const turn = new OpenAIChatCompletionsModel(client, model, costCapture, 'openrouter', {
    requestOptions: openRouterRequestOptions,
    reportsUpstreamProvider: true,
  });
  return {
    async *stream(request) {
      try {
        yield* turn.stream(request);
      } catch (error) {
        throw withUpstreamErrorDetail(error);
      }
    },
  };
}

const MAX_UPSTREAM_ERROR_DETAIL_LENGTH = 500;

/**
 * OpenRouter's own message for an upstream failure is often just "Provider
 * returned error"; which upstream failed and what it said are in
 * `error.metadata`. Append them so the message a user sees names the cause.
 *
 * Failure classification reads the message for words such as "abort" or
 * "connection error", so upstream text can steer it. The SDK this replaced put
 * the same text in the message, so that exposure is unchanged.
 */
function withUpstreamErrorDetail(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const body = (error as { error?: unknown }).error;
  const metadata = isRecord(body) && isRecord(body.metadata) ? body.metadata : undefined;
  if (!metadata) return error;
  const upstream = typeof metadata.provider_name === 'string' ? metadata.provider_name.trim() : '';
  const raw =
    typeof metadata.raw === 'string' ? metadata.raw : metadata.raw == null ? '' : JSON.stringify(metadata.raw);
  const detail = [upstream ? `[${upstream}]` : '', raw.trim().slice(0, MAX_UPSTREAM_ERROR_DETAIL_LENGTH)]
    .filter(Boolean)
    .join(' ');
  if (detail && !error.message.includes(detail)) error.message = `${error.message}: ${detail}`;
  return error;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * OpenRouter's body fields for the selected effort and the caller's options.
 *
 * Options reach this provider in three spellings that must all land flat in
 * the request body: top-level keys, an `openrouter` namespace, and an
 * `openrouter` namespace under a nested `providerOptions`. Later spellings win,
 * except that a top-level `reasoning` beats a namespaced one.
 * Effort is `reasoning: { effort }` here rather than `reasoning_effort`, and an
 * explicit `reasoning` in any spelling replaces the selected effort.
 */
function openRouterRequestOptions(request: StreamedModelTurnRequest): Record<string, unknown> {
  const {
    providerOptions: nested,
    openrouter: direct,
    reasoning: topLevelReasoning,
    ...rest
  } = (request.providerOptions ?? {}) as Record<string, unknown>;
  const namespaced = {
    ...(isRecord(direct) ? direct : {}),
    ...(isRecord(nested) && isRecord(nested.openrouter) ? nested.openrouter : {}),
  };
  const effort = request.reasoning?.effort;
  const reasoning =
    topLevelReasoning ?? namespaced.reasoning ?? (effort && effort !== 'default' ? { effort } : undefined);
  return { ...rest, ...namespaced, ...(reasoning ? { reasoning } : {}) };
}

function sanitizeOpenRouterReasoningDetails(messages: any[]): void {
  const requiresSignature = new Set(['google-gemini-v1', 'anthropic-claude-v1']);
  for (const message of messages) {
    if (!Array.isArray(message?.reasoning_details)) {
      continue;
    }
    message.reasoning_details = message.reasoning_details.filter((detail: any) => {
      if (detail?.type !== 'reasoning.text') {
        return true;
      }
      if (!requiresSignature.has(detail?.format)) {
        return true;
      }
      return Boolean(detail?.signature);
    });
  }
}

export const openRouterPreprocessingMiddleware: FetchMiddleware = async (ctx, next) => {
  if (typeof ctx.init?.body === 'string') {
    try {
      const body = JSON.parse(ctx.init.body);
      if (Array.isArray(body?.messages)) {
        sanitizeOpenRouterReasoningDetails(body.messages);
        addCacheControlToLastTwoMessages(body.messages, body.model);
        ctx.init = { ...ctx.init, body: JSON.stringify(body) };
      }
    } catch {
      /* fall through */
    }
  }
  return next(ctx);
};

async function fetchOpenRouterModels(
  deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch,
): Promise<Array<{ id: string; name?: string }>> {
  const { settingsService } = deps;

  const baseUrl = settingsService.get('agent.openrouter.baseUrl') || 'https://openrouter.ai/api/v1';
  const apiKey = settingsService.get('agent.openrouter.apiKey') || process.env.OPENROUTER_API_KEY;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(`${baseUrl}/models`, { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed (${response.status})`);
  }

  const body = await response.json();
  const twoYearsAgo = new Date();
  twoYearsAgo.setUTCFullYear(twoYearsAgo.getUTCFullYear() - 2);
  const minimumCreatedAt = twoYearsAgo.getTime() / 1000;
  const filteredData = (body?.data || []).filter(
    (item: any) =>
      Array.isArray(item?.supported_parameters) &&
      item.supported_parameters.includes('tools') &&
      typeof item.created === 'number' &&
      Number.isFinite(item.created) &&
      item.created >= minimumCreatedAt,
  );

  if (!Array.isArray(filteredData)) return [];

  return filteredData
    .map((item: any) => {
      const id = item?.id || item?.model || '';
      const name = item?.name || item?.display_name || item?.description;
      return id ? { id, name } : null;
    })
    .filter(Boolean) as Array<{ id: string; name?: string }>;
}

// Register OpenRouter provider
registerProvider(
  {
    id: 'openrouter',
    label: 'OpenRouter',
    createStreamedModel: async (model, deps): Promise<StreamedModelTurn> => {
      const streamedModel = await createOpenRouterModel(deps, model);
      if (!streamedModel) throw new Error('OpenRouter API key is not configured');
      const retryAttempts = deps.retryAttempts ?? deps.settingsService.get('agent.retryAttempts') ?? 2;
      return new RetryingModel(streamedModel, {
        retryAttempts,
        loggingService: deps.loggingService,
        onRetry: deps.onRetry,
      });
    },
    fetchModels: fetchOpenRouterModels,
    sensitiveSettingKeys: [
      'agent.openrouter.apiKey',
      'agent.openrouter.baseUrl',
      'agent.openrouter.referrer',
      'agent.openrouter.title',
    ],
    capabilities: {
      supportsFlexServiceTier: true,
      supportsConversationChaining: false,
    },
  },
  { builtin: true },
);
