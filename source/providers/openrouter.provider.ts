import { RetryingModel } from './retrying-model.js';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { AiSdkOpenRouterProvider } from './ai-sdk-openrouter.provider.js';
import { createProviderFetch } from './fetch/composer.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { addCacheControlToLastTwoMessages } from './common/openai-compatible-messages.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import type { ISettingsService } from '../services/service-interfaces.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';

function createOpenRouterModel(deps: ProviderDeps, model: string) {
  const { settingsService, loggingService, sessionContextService } = deps;
  const apiKey = settingsService.get('agent.openrouter.apiKey') || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  return new AiSdkOpenRouterProvider({
    defaultModel: model,
    resolveConfig: () => ({
      baseURL: settingsService.get('agent.openrouter.baseUrl') || 'https://openrouter.ai/api/v1',
      apiKey,
      headers: {
        'HTTP-Referer': settingsService.get('agent.openrouter.referrer') || 'https://github.com/qduc/term2',
        'X-Title': settingsService.get('agent.openrouter.title') || 'term2',
      },
      appUrl: settingsService.get('agent.openrouter.referrer') || 'https://github.com/qduc/term2',
      appName: settingsService.get('agent.openrouter.title') || 'term2',
      fetch: createProviderFetch({
        providerId: 'openrouter',
        defaultModel: settingsService.get('agent.modelSelection').model || model,
        deps: {
          loggingService,
          sessionContextService: sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE,
        },
        middlewares: [openRouterPreprocessingMiddleware, createOpenRouterArmorMiddleware(settingsService)],
      }),
    }),
  });
}

// Apply at the wire boundary, on every request, including continuations/retries.
// Do not allow per-call provider options to weaken the opted-in policy.
function createOpenRouterArmorMiddleware(settingsService: ISettingsService): FetchMiddleware {
  return async (ctx, next) => {
    if (settingsService.get('agent.openrouter.armorEnabled') !== true) return next(ctx);
    const url = ctx.url instanceof Request ? ctx.url.url : String(ctx.url);
    if (!new URL(url).pathname.endsWith('/chat/completions') || typeof ctx.init?.body !== 'string') {
      throw new Error('OpenRouter Armor requires a JSON Chat Completions request');
    }
    const body = JSON.parse(ctx.init.body);
    if (!Array.isArray(body.messages) || (body.plugins !== undefined && !Array.isArray(body.plugins))) {
      throw new Error('OpenRouter Armor requires messages and a valid plugins array');
    }
    body.plugins = [
      ...(body.plugins ?? []).filter((plugin: { id?: string } | null) => plugin?.id !== 'armor'),
      {
        id: 'armor',
        mode: 'enforce',
        on_error: 'block',
        output_mode: 'text',
        use_cc_style_default_rules: true,
      },
    ];
    ctx.init = { ...ctx.init, body: JSON.stringify(body) };
    return next(ctx);
  };
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
    createStreamedModel: (model, deps): StreamedModelTurn => {
      const provider = createOpenRouterModel(deps, model);
      if (!provider) throw new Error('OpenRouter API key is not configured');
      const streamedModel = provider.getStreamedModel(model);
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
      supportsConversationChaining: false,
    },
  },
  { builtin: true },
);
