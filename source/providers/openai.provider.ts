import { randomUUID } from 'node:crypto';
import { Runner, Model, ModelProvider } from '@openai/agents';
import { OpenAIResponsesModel } from '@openai/agents-openai';
import OpenAI from 'openai';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import { RetryingModel } from './retrying-model.js';
import { TimedResponsesWSModel } from './timed-responses-ws-model.js';
import { DEFAULT_TIMED_WS_TIMEOUTS } from './timed-ws-timeouts.js';
import type { ILoggingService, ISessionContextService } from '../services/service-interfaces.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session-context-service.js';

function forwardPromptCacheKey(request: any, requestData: Record<string, unknown>): Record<string, unknown> {
  const promptCacheKey = request?.modelSettings?.prompt_cache_key;
  if (typeof promptCacheKey === 'string' && promptCacheKey.length > 0) {
    return {
      ...requestData,
      prompt_cache_key: promptCacheKey,
    };
  }

  return requestData;
}

export class OpenAIResponsesModelWithPromptCacheKey extends OpenAIResponsesModel {
  _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest.call(this, request, stream);
    return {
      ...built,
      requestData: forwardPromptCacheKey(request, built.requestData),
    };
  }
}

export class TimedOpenAIResponsesWSModel extends TimedResponsesWSModel {
  _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = super._buildResponsesCreateRequest(request, stream);
    return {
      ...built,
      requestData: forwardPromptCacheKey(request, built.requestData),
    };
  }
}

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

async function fetchOpenAIModels(
  deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch as any,
): Promise<Array<{ id: string; name?: string }>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = deps.settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(OPENAI_MODELS_URL, { headers });
  if (!response.ok) {
    throw new Error(`OpenAI models request failed (${response.status})`);
  }

  const body = await response.json();
  const raw = body?.data || [];

  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: any) => {
      const id = item?.id || item?.model || '';
      const name = item?.name || item?.display_name || item?.description;
      return id ? { id, name } : null;
    })
    .filter(Boolean)
    .reverse() as Array<{ id: string; name?: string }>;
}

export function writeProviderTrafficArtifact(
  loggingService: Pick<ILoggingService, 'debug' | 'error' | 'getCorrelationId'> | undefined,
  sessionContextService: ISessionContextService | undefined,
  provider: string,
  model: string,
  modelClass: string,
  modelWrapperClass: string,
  event: 'request.started' | 'response.received' | 'response.failed',
  meta?: Record<string, unknown>,
): void {
  if (!loggingService) return;

  const trafficContext = sessionContextService?.getContext() ?? null;
  const isEvaluator = trafficContext?.evaluator === true;
  const eventPrefix = isEvaluator ? 'evaluator' : 'provider';

  const baseMeta: Record<string, unknown> = {
    requestId: meta?.requestId ?? randomUUID(),
    traceId: trafficContext?.traceId ?? loggingService.getCorrelationId?.(),
    sessionId: trafficContext?.sessionId,
    sessionStartedAt: trafficContext?.sessionStartedAt,
    firstUserMessagePreview: trafficContext?.firstUserMessagePreview,
    mode: trafficContext?.mode,
    provider,
    model,
    modelClass,
    modelWrapperClass,
  };

  const eventType = event === 'response.failed' ? 'provider.response.failed' : `${eventPrefix}.${event}`;

  if (event === 'request.started') {
    loggingService.debug(`${provider} ws request start`, {
      eventType,
      category: 'provider',
      phase: 'request_start',
      direction: 'sent',
      ...baseMeta,
      ...meta,
    });
  } else if (event === 'response.received') {
    loggingService.debug(`${provider} ws response received`, {
      eventType,
      category: 'provider',
      phase: 'provider_response',
      direction: 'received',
      ...baseMeta,
      ...meta,
    });
  } else if (event === 'response.failed') {
    loggingService.error(`${provider} ws request failed`, {
      eventType,
      category: 'provider',
      phase: 'provider_response',
      ...baseMeta,
      ...meta,
    });
  }
}

class OpenAIProvider implements ModelProvider {
  private readonly models = new Map<string, RetryingModel>();

  constructor(
    private readonly openAIClient: OpenAI,
    private readonly loggingService: any,
    private readonly transport: 'websocket' | 'http',
    private readonly retryAttempts: number,
    private readonly onRetry?: () => void,
  ) {}

  getModel(modelName?: string): Model {
    const model = modelName || 'gpt-4o';
    const cached = this.models.get(model);
    if (cached) {
      return cached;
    }

    const selectedModel =
      this.transport === 'http'
        ? new OpenAIResponsesModelWithPromptCacheKey(this.openAIClient as any, model)
        : new TimedOpenAIResponsesWSModel(this.openAIClient as any, model, {
            ...DEFAULT_TIMED_WS_TIMEOUTS,
          });
    const retryingModel = new RetryingModel(selectedModel, {
      retryAttempts: this.retryAttempts,
      loggingService: this.loggingService,
      onRetry: this.onRetry,
    });

    this.models.set(model, retryingModel);
    return retryingModel;
  }

  async close(): Promise<void> {
    for (const model of this.models.values()) {
      await model.close();
    }
    this.models.clear();
  }
}

// Register OpenAI provider
registerProvider({
  id: 'openai',
  label: 'OpenAI',
  createRunner: ({ settingsService, loggingService, sessionContextService, onRetry }) => {
    const defaultModel = settingsService.get('agent.model') || 'gpt-4o';
    const apiKey = settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
    const openAIClient = new OpenAI({
      apiKey: apiKey || 'placeholder',
      maxRetries: 0,
      fetch: createProviderFetch({
        providerId: 'openai',
        defaultModel,
        deps: { loggingService, sessionContextService: sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE },
      }) as any,
    });

    return new Runner({
      modelProvider: new OpenAIProvider(
        openAIClient,
        loggingService,
        settingsService.get('agent.transport') ?? 'websocket',
        settingsService.get('agent.retryAttempts') ?? 2,
        onRetry,
      ),
    });
  },
  fetchModels: fetchOpenAIModels,
  clearConversations: undefined, // No conversation state to clear
  sensitiveSettingKeys: [],
  capabilities: {
    supportsConversationChaining: true,
    supportsTracingControl: true,
    supportsPromptCacheKey: true,
    usesStrictToolSchema: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  },
});
