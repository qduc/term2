import { DEFAULT_ASSUMED_CONTEXT_WINDOW } from './index.js';
import { stringArray } from './provider-settings.js';
import { weeklyQuota } from './provider-quota.js';
import { observeProviderRequestDispatch } from './providers/request-dispatch.js';
/**
 * Real providers behind `ModelRegistry`, without the adopted adapter. The only
 * place that sees provider shapes: `Item` converts here and nowhere else.
 *
 * `resolve` is synchronous and source `createStreamedModel` is not, so the
 * returned `Model` creates the provider model on first `stream`.
 *
 * Settings map as the run loop maps them: temperature, `reasoning` as the agent
 * factory's `{ effort, summary: 'auto' }`, `maxOutputTokens` as `maxTokens`,
 * `providerOptions` as given, and the prompt cache key where `getAgent` puts it.
 * The cache key comes from the ambient session context (`getContext()`), which
 * the caller sets around the turn; a request carries no conversation id.
 *
 * Only an engine-prepared accepted continuation may select provider chaining.
 * Unanchored requests explicitly suppress adapter-local history caches. SDK
 * retries are disabled. With request.recovery, the engine owns every retry
 * dispatch and this adapter only checks its shared reservation.
 */

import { randomUUID } from 'node:crypto';
import type {
  ContextCompactionSessionState,
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../shared/contracts/streamed-model-turn.js';
import type {
  ILoggingService,
  ISessionContextService,
  ISettingsService,
  SessionTrafficContext,
} from '../shared/service-interfaces.js';
import type { ProviderDefinition } from './providers/registry.js';
import { getProvider } from './providers/index.js';
import { extractAiSdkUpstreamProvider } from './providers/ai-sdk-streamed-model.js';
import { StreamingSpeedTracker } from '../shared/utils/streaming/streaming-speed-tracker.js';
import { getModelContextWindow } from './providers/model-catalog/catalog.js';
import { MODEL_CATALOG } from './providers/model-catalog/catalog.generated.js';
import { ModelFailure, toModelFailure } from './failure.js';
import { foreignCompactionRefusal } from './history-compatibility.js';
import { physicalModelStream } from './retry.js';
import { codexCompact } from './provider-compact.js';
import {
  itemToInput,
  withConversationTiming,
  toolDefinition,
  outputToItem,
  toUsage,
  stopReason,
} from './provider-items.js';
import type {
  Model,
  ModelError,
  ModelCapabilities,
  ModelEvent,
  ModelRef,
  ModelRegistry,
  ModelRequest,
  ToolCallId,
} from './index.js';

export type ProviderRegistryDeps = {
  readonly settings: ISettingsService;
  readonly logger: ILoggingService;
  readonly sessionContext: ISessionContextService;
};

const DEFAULT_RETRY_ATTEMPTS = 2;
export function createProviderRegistry(deps: ProviderRegistryDeps): ModelRegistry {
  const models = new Map<string, Model>();
  // Process-wide, as the run loop keeps it per session: once a provider rejects
  // server-side compaction, the option is dropped from later requests.
  const compaction: ContextCompactionSessionState = { disabled: false };
  return {
    resolve(ref) {
      const key = `${ref.provider}\u0000${ref.model}`;
      const cached = models.get(key);
      if (cached) return cached;
      const provider = getProvider(ref.provider);
      if (!provider?.createStreamedModel) {
        throw new Error(`Provider '${ref.provider}' does not expose an application streamed model.`);
      }
      const model = lazyModel(ref, provider, deps, compaction);
      if (model.catalogContextWindow === undefined)
        deps.logger.warn('Model context window unknown; automatic compaction assumes 128,000 tokens', ref);
      models.set(key, model);
      return model;
    },
    list() {
      return Object.entries(MODEL_CATALOG as Record<string, Record<string, unknown>>).flatMap(([provider, catalog]) =>
        getProvider(provider) ? Object.keys(catalog).map((model) => ({ provider, model })) : [],
      );
    },
  };
}

function lazyModel(
  ref: ModelRef,
  provider: ProviderDefinition,
  deps: ProviderRegistryDeps,
  compaction: ContextCompactionSessionState,
): Model {
  const owner = randomUUID();
  const capabilities: ModelCapabilities = {
    continuity: provider.capabilities?.supportsConversationChaining === true,
    standardServiceTier:
      provider.id === 'openai' && !provider.isRuntimeDefined && provider.capabilities?.supportsFlexServiceTier === true,
    httpTransportDowngrade: !provider.isRuntimeDefined && (provider.id === 'openai' || provider.id === 'codex'),
  };
  const variants = new Map<string, Promise<StreamedModelTurn>>();
  const turnModel = (transport: string): Promise<StreamedModelTurn> => {
    const existing = variants.get(transport);
    if (existing) return existing;
    // Source providers cache by context-service identity. Each model/transport
    // gets an isolated identity but delegates real ambient context unchanged.
    const sessionContext: ISessionContextService = {
      getContext: () => deps.sessionContext.getContext(),
      runWithContext: (context, fn) => deps.sessionContext.runWithContext(context, fn),
    };
    const created = Promise.resolve()
      .then(() =>
        provider.createStreamedModel!(ref.model, {
          settingsService: factorySettings(deps.settings, transport),
          loggingService: deps.logger,
          sessionContextService: sessionContext,
          // No provider RetryingModel: the engine owns retries. The SDK keeps legacy's
          // pre-response retries of one HTTP request (same posts and backoff).
          retryAttempts: 0,
          contextCompactionSessionState: compaction,
        }),
      )
      .catch((error: unknown) => {
        variants.delete(transport);
        throw error;
      });
    variants.set(transport, created);
    return created;
  };
  const catalogContextWindow = getModelContextWindow(ref.provider, ref.model);
  return {
    ref,
    capabilities,
    contextWindow: catalogContextWindow ?? DEFAULT_ASSUMED_CONTEXT_WINDOW,
    ...(catalogContextWindow !== undefined ? { catalogContextWindow } : {}),
    // Legacy uses Codex's compact endpoint for native compaction; other providers compact locally.
    ...(ref.provider === 'codex' ? { compact: codexCompact(ref, deps.settings, turnModel) } : {}),
    async *stream(request, signal, onDispatched) {
      const transport = request.downgradeTransport ? 'http' : deps.settings.get('agent.transport') ?? 'websocket';
      try {
        signal.throwIfAborted();
        if (request.model.provider !== ref.provider || request.model.model !== ref.model) {
          throw new ModelFailure({
            kind: 'invalid_request',
            retryable: false,
            message: 'Resolved Model does not match ModelRequest.model.',
          });
        }
        if (request.downgradeTransport && !capabilities.httpTransportDowngrade) {
          throw unsupportedControl('HTTP transport downgrade', ref);
        }
        if (request.useStandardServiceTier && !capabilities.standardServiceTier) {
          throw unsupportedControl('Standard service tier', ref);
        }
        const prepared = toProviderRequest(request, signal, {
          provider,
          ref,
          context: deps.sessionContext.getContext(),
          compaction,
          owner,
          transport,
          capabilities,
          settings: deps.settings,
        });
        const extraBody = isRecord(prepared.providerOptions?.extraBody) ? prepared.providerOptions.extraBody : {};
        const tier = extraBody.service_tier ?? prepared.providerOptions?.service_tier;
        yield* physicalModelStream({
          request,
          signal,
          maxRetries: deps.settings.get('agent.retryAttempts') ?? DEFAULT_RETRY_ATTEMPTS,
          scope: { capabilities, websocket: transport === 'websocket', flex: tier === 'flex' },
          stream: async function* () {
            const stopped = new AbortController();
            const linked = AbortSignal.any([signal, stopped.signal]);
            try {
              linked.throwIfAborted();
              const turn = await turnModel(transport);
              linked.throwIfAborted();
              yield* observeProviderRequestDispatch(
                modelEvents(
                  turn,
                  { ...prepared, signal: linked },
                  ref.provider,
                  linked,
                  capabilities.continuity
                    ? { kind: 'direct_response', owner, provider: ref.provider, model: ref.model, transport }
                    : undefined,
                ),
                onDispatched,
              );
            } finally {
              // Returning early from a generator alone does not close HTTP/WS.
              stopped.abort();
            }
          },
        });
      } catch (error) {
        throw toModelFailure(error, signal);
      }
    },
  };
}

/** Non-mutating settings overlay; SDK factories read either get or getDynamic. */
function factorySettings(settings: ISettingsService, transport: string): ISettingsService {
  return new Proxy(settings, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'get' || property === 'getDynamic') {
        return (key: string): unknown => (key === 'agent.transport' ? transport : value.call(target, key));
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function unsupportedControl(control: string, ref: ModelRef): ModelFailure {
  return new ModelFailure({
    kind: 'invalid_request',
    retryable: false,
    message: `${control} is not supported by adapter '${ref.provider}'.`,
  });
}

type ResponseIdentity = {
  readonly kind: 'direct_response';
  readonly owner: string;
  readonly provider: string;
  readonly model: string;
  readonly transport: string;
};
type ResponseContinuation = ResponseIdentity & { readonly responseId: string };

function toProviderRequest(
  request: ModelRequest,
  signal: AbortSignal,
  scope: {
    readonly provider: ProviderDefinition;
    readonly ref: ModelRef;
    readonly context: SessionTrafficContext | null;
    readonly compaction: ContextCompactionSessionState;
    readonly owner: string;
    readonly transport: string;
    readonly capabilities: ModelCapabilities;
    readonly settings: ISettingsService;
  },
): StreamedModelTurnRequest {
  const { provider, ref, context, compaction } = scope;
  const refusal = foreignCompactionRefusal(request.input, ref.provider);
  if (refusal) throw new ModelFailure({ kind: 'invalid_request', retryable: false, message: refusal });
  const continuation = resolveContinuation(request, scope);
  let providerOptions: Record<string, unknown> | undefined = request.providerOptions
    ? { ...request.providerOptions }
    : undefined;
  if (providerOptions && compaction.disabled) delete providerOptions.contextCompaction;
  if (scope.capabilities.continuity && providerOptions) {
    // Continuation authority is the prepared request, not an escape-hatch key
    // that can override previous_response_id after the source body is built.
    const { previous_response_id: _rawAnchor, previousResponseId: _alias, ...rest } = providerOptions;
    providerOptions = rest;
    if (isRecord(providerOptions.extraBody)) {
      const {
        previous_response_id: _extraAnchor,
        previousResponseId: _extraAlias,
        ...extra
      } = providerOptions.extraBody;
      providerOptions = { ...providerOptions, extraBody: extra };
    }
  }
  if (scope.capabilities.standardServiceTier) {
    const extra = isRecord(providerOptions?.extraBody) ? providerOptions.extraBody : {};
    if (request.useStandardServiceTier) {
      // OpenAI's actual wire enum is 'default', not the UI word 'standard'.
      const { serviceTier: _alias, ...rest } = providerOptions ?? {};
      const { serviceTier: _extraAlias, ...restExtra } = extra;
      providerOptions = { ...rest, service_tier: 'default', extraBody: { ...restExtra, service_tier: 'default' } };
    } else if (
      providerOptions?.service_tier === undefined &&
      extra.service_tier === undefined &&
      scope.settings.get('agent.useFlexServiceTier')
    ) {
      providerOptions = { ...providerOptions, service_tier: 'flex' };
    }
    // The source agent factory also supplies a top-level tier. Responses reads
    // wire extensions only from extraBody; an explicit extra-body tier wins.
    const tier = providerOptions?.service_tier;
    const body = isRecord(providerOptions?.extraBody) ? providerOptions.extraBody : {};
    if (tier !== undefined && body.service_tier === undefined) {
      providerOptions = { ...providerOptions, extraBody: { ...body, service_tier: tier } };
    }
  }

  // Mirrors `getAgent` (cache key) and `toApplicationCodexSettings` (codex). Other
  // placements are dropped there too, so the run loop never sends them.
  const cacheKey =
    context && provider.capabilities?.supportsPromptCacheKey ? context.promptCacheKey ?? context.sessionId : undefined;
  const extraBodyKey = provider.capabilities?.promptCacheKeyPlacement === 'responses-extra-body';
  if (cacheKey && extraBodyKey) {
    const extraBody = isRecord(providerOptions?.extraBody) ? providerOptions.extraBody : {};
    providerOptions = { ...providerOptions, extraBody: { ...extraBody, prompt_cache_key: cacheKey } };
  }
  // `store` and `include` are not in TurnSpec: they come from the provider's defaults,
  // which the agent factory merges into top-level modelSettings. Only codex reads
  // `include`, and the run loop never reads `store`.
  let codex: { promptCacheKey?: string; include?: readonly string[] } | undefined;
  if (ref.provider === 'codex') {
    const promptCacheKey = cacheKey && !extraBodyKey ? cacheKey : undefined;
    const include = stringArray(provider.defaultModelSettings?.().include);
    if (promptCacheKey !== undefined || include !== undefined) {
      codex = {
        ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
        ...(include !== undefined ? { include } : {}),
      };
    }
  }

  return {
    instructions: request.instructions,
    input: request.input.flatMap((item) => withConversationTiming(item, itemToInput(item))),
    tools: request.tools.map(toolDefinition),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.reasoning ? { reasoning: { effort: request.reasoning, summary: 'auto' as const } } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
    ...(codex ? { codex } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    signal,
    ...continuation,
    ...(request.recovery ? { recoveryBudget: request.recovery.budget } : {}),
  };
}

// ---------- Provider stream -> ModelEvent ----------

async function* modelEvents(
  turn: StreamedModelTurn,
  request: StreamedModelTurnRequest,
  providerId: string,
  signal: AbortSignal,
  continuation?: ResponseIdentity,
): AsyncIterable<ModelEvent> {
  const streamedToolCalls = new Map<string, Extract<StreamedModelTurnEvent, { type: 'tool_call' }>>();
  let completed = false;
  const speed = new StreamingSpeedTracker();
  let streamedReasoning = false;
  for await (const event of turn.stream(request)) {
    signal.throwIfAborted();
    switch (event.type) {
      case 'codex_rate_limits':
        if (providerId === 'codex') yield { type: 'codex_quota', quota: weeklyQuota(event.rateLimits) };
        break;
      case 'text_delta':
        speed.recordDelta(event.text);
        yield { type: 'text_delta', delta: event.text, ...(event.partId ? { partId: event.partId } : {}) };
        break;
      case 'reasoning_delta':
        if (event.text) streamedReasoning = true;
        speed.recordDelta(event.text);
        yield {
          type: 'reasoning_delta',
          delta: event.text,
          ...(event.id ? { id: event.id } : {}),
          ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
        };
        break;
      case 'tool_call_streaming_delta':
        speed.recordCumulativeChars(event.argumentCharCount);
        yield {
          type: 'tool_call_streaming_delta',
          argumentCharCount: event.argumentCharCount,
          ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
          ...(event.callId !== undefined ? { callId: event.callId as ToolCallId } : {}),
          ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
          ...(event.callIndex !== undefined ? { callIndex: event.callIndex } : {}),
        };
        break;
      case 'tool_call':
        // The completion's output is authoritative. Keep the streamed call as a fallback.
        streamedToolCalls.set(event.id, event);
        break;
      case 'completion': {
        completed = true;
        if (event.usage) {
          const measured = speed.getSettledTps({
            completionTokens: event.usage.outputTokens,
            reasoningTokens: streamedReasoning ? undefined : event.usage.reasoningTokens,
          });
          // Legacy application-run-loop: the upstream an aggregator reports rides on the request's usage.
          const upstreamProvider = extractAiSdkUpstreamProvider(event.providerMetadata);
          yield {
            type: 'usage',
            usage: { ...toUsage(event.usage), ...(upstreamProvider ? { upstreamProvider } : {}) },
            ...(measured && measured.decodeWindowMs == null
              ? { speed: { tps: measured.tps, approximate: measured.approximate } }
              : {}),
          };
        }
        const completedToolCalls = new Set<string>();
        for (const output of event.output) {
          if (output.type === 'tool_call') {
            const streamed = streamedToolCalls.get(output.id);
            if (streamed) completedToolCalls.add(output.id);
            const merged = streamed
              ? {
                  ...streamed,
                  ...output,
                  ...(output.providerMetadata !== undefined || streamed.providerMetadata === undefined
                    ? {}
                    : { providerMetadata: streamed.providerMetadata }),
                  ...(streamed.toolType ? { toolType: streamed.toolType } : {}),
                }
              : output;
            yield { type: 'item', item: outputToItem(merged, providerId) };
            continue;
          }
          yield { type: 'item', item: outputToItem(output, providerId) };
        }
        for (const [callId, streamed] of streamedToolCalls) {
          if (!completedToolCalls.has(callId)) yield { type: 'item', item: outputToItem(streamed, providerId) };
        }
        yield {
          type: 'done',
          stopReason: stopReason(event.finishReason),
          ...(continuation && event.responseId
            ? { continuation: { ...continuation, responseId: event.responseId } satisfies ResponseContinuation }
            : {}),
          ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        };
        break;
      }
      default:
        break;
    }
  }
  // A stream that ends without its completion is a failure, not a finished answer.
  if (!completed) {
    const truncated: ModelError = {
      kind: 'network',
      message: 'Model stream ended before the response completed.',
      retryable: false,
    };
    throw truncated;
  }
}

/** Reject a foreign/stale opaque token instead of sending an anchorless delta. */
function resolveContinuation(
  request: ModelRequest,
  scope: {
    owner: string;
    ref: ModelRef;
    transport: string;
    capabilities: ModelCapabilities;
  },
): Pick<StreamedModelTurnRequest, 'previousResponseId' | 'disableChaining'> {
  if (request.disableChaining) return { previousResponseId: null, disableChaining: true };
  let responseId = request.previousResponseId;
  if (request.continuation != null) {
    const token = request.continuation as Partial<ResponseContinuation>;
    if (
      typeof token !== 'object' ||
      token.kind !== 'direct_response' ||
      token.owner !== scope.owner ||
      token.provider !== scope.ref.provider ||
      token.model !== scope.ref.model ||
      token.transport !== scope.transport ||
      typeof token.responseId !== 'string' ||
      !token.responseId ||
      responseId === null ||
      (responseId !== undefined && responseId !== token.responseId)
    ) {
      throw new ModelFailure({
        kind: 'invalid_request',
        message: 'Provider continuation is foreign, stale or conflicts with the request.',
        retryable: false,
      });
    }
    responseId = token.responseId;
  }
  if (responseId && !scope.capabilities.continuity) throw unsupportedControl('Provider continuity', scope.ref);
  if (request.downgradeTransport && responseId) {
    throw new ModelFailure({
      kind: 'invalid_request',
      message: 'HTTP transport downgrade requires a self-contained full-history request.',
      retryable: false,
    });
  }
  return responseId
    ? { previousResponseId: responseId, disableChaining: false }
    : { previousResponseId: null, disableChaining: true };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
