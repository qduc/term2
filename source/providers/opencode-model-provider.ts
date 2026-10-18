import OpenAI from 'openai';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';
import {
  buildProviderFetch,
  type CustomProviderConfig,
  type CustomProviderRuntimeDeps,
} from './custom-provider-runtime.js';
import { isOpencodeProvider, isOpencodeTrailer, resolveOpencodeRuntimeConfig } from './opencode.provider.js';
import { generateOpencodeSessionId } from './opencode-session.js';
import {
  findKnownOpencodeModelTransport,
  selectOpencodeModelTransport,
  shouldApplyOpencodeAnthropicPromptCaching,
} from './opencode-routing.js';
import { CachedOpencodeTransportDiscovery, type OpencodeTransportDiscovery } from './opencode-transport-discovery.js';
import { createOpencodeSessionMiddleware } from './opencode-middleware.js';
import { createOpenAICompatibleMiddleware, createOpenAIResponsesMiddleware } from './openai-compatible-middleware.js';
import { createAnthropicChatCachingMiddleware } from './anthropic-chat-caching.js';
import { AiSdkAnthropicProvider } from './ai-sdk-anthropic.provider.js';
import { applyClientResponseNormalization, type CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';
import { OpenAIResponsesModelWithPromptCacheKey } from './openai-responses-model.js';
import { normalizeBaseUrl } from './common/openai-compatible-utils.js';

export class OpencodeAnthropicFormatProvider {
  private readonly fallbackSessionId: string | undefined;
  private readonly transportDiscovery: OpencodeTransportDiscovery;

  constructor(
    private readonly config: CustomProviderConfig,
    private readonly deps: CustomProviderRuntimeDeps & { opencodeTransportDiscovery?: OpencodeTransportDiscovery },
  ) {
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
          createOpencodeSessionMiddleware(
            { type: this.config.type || 'opencode', baseUrl: runtimeConfig.baseUrl },
            {
              sessionContextService: this.deps.sessionContextService,
              fallbackSessionIdOverride: this.fallbackSessionId,
            },
          ),
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
        createOpenAIResponsesMiddleware(),
        createOpencodeSessionMiddleware(
          { type: this.config.type || 'opencode', baseUrl: runtimeConfig.baseUrl },
          {
            sessionContextService: this.deps.sessionContextService,
            fallbackSessionIdOverride: this.fallbackSessionId,
          },
        ),
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
        createOpenAICompatibleMiddleware(),
        createAnthropicChatCachingMiddleware(),
        createOpencodeSessionMiddleware(
          { type: this.config.type || 'opencode', baseUrl: runtimeConfig.baseUrl },
          {
            sessionContextService: this.deps.sessionContextService,
            fallbackSessionIdOverride: this.fallbackSessionId,
          },
        ),
      ]),
    });
    const costCapture: CostTrailerCapture = {};
    applyClientResponseNormalization(openAIClient, this.deps.loggingService, costCapture, isOpencodeTrailer);
    return new OpenAIChatCompletionsModel(
      openAIClient,
      resolvedModel,
      costCapture,
      this.config.name || this.config.type || 'openai-compatible',
    );
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
