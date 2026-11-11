import { ModelEventProjection, type ResponseContinuation } from './providers/runtime/model-events.js';
import {
  createSessionAccountStore,
  getSessionAccount,
  type SessionAccountStore,
} from './providers/oauth-session-account.js';
import { stringArray } from './provider-settings.js';

/**
 * Term2's scheduling assumption for models it cannot size from the catalogue,
 * supplied to the core as `Model.contextWindow`. It only schedules automatic
 * compaction; it is not provider capacity or an admission limit.
 */
const UNKNOWN_MODEL_CONTEXT_WINDOW = 500_000;
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
 * Identity comes only from ModelRequest.affinity. Provider adapters receive a
 * request-scoped context owned by this registry, never the app's ambient session.
 *
 * Only an engine-prepared accepted continuation may select provider chaining.
 * Unanchored requests explicitly suppress adapter-local history caches. SDK
 * retries are disabled. With request.recovery, the engine owns every retry
 * dispatch and this adapter only checks its shared reservation.
 */

import { randomUUID } from 'node:crypto';
import { requestTrafficContext, ProviderRequestScope } from './providers/runtime/request-scope.js';
import type {
  ContextCompactionSessionState,
  StreamedModelTurn,
  StreamedModelTurnRequest,
} from './streamed-model-turn.js';
import type {
  ILoggingService,
  ISessionContextService,
  ISettingsService,
  SessionTrafficContext,
} from '../shared/service-interfaces.js';
import type { ProviderDefinition, ProviderRegistry as SourceProviderRegistry } from './providers/registry.js';
import { createProviderRegistry as createSourceProviderRegistry } from './providers/index.js';
import { createOpenAICompatibleProviderDefinition } from './providers/openai-compatible-lazy.js';
import { decodeStoredCustomProviderConfigs } from '../config/settings/custom-provider-normalization.js';
import { getModelContextWindow } from './providers/model-catalog/catalog.js';
import { MODEL_CATALOG } from './providers/model-catalog/catalog.generated.js';
import { ModelFailure, toModelFailure } from './failure.js';
import { physicalModelStream } from './retry.js';
import { codexCompact } from './provider-compact.js';
import { historyToInput, toolDefinition } from './provider-items.js';
import type { Model, ModelCapabilities, ModelRef, ModelRegistry, ModelRequest } from './index.js';

export type ProviderRegistryDeps = {
  readonly settings: ISettingsService;
  readonly logger: ILoggingService;
  /** A host may retain this pin across root registry generations of one session. */
  readonly sessionAccountStore?: SessionAccountStore;
  /** Definitions are snapshotted for this instance; later registrations need a new registry. */
  readonly providers?: Pick<SourceProviderRegistry, 'getAllProviders'>;
  /** Compatibility input for host composition; provider identity never reads this service. */
  readonly sessionContext?: ISessionContextService;
};

const DEFAULT_RETRY_ATTEMPTS = 2;
export function createProviderRegistry(deps: ProviderRegistryDeps): ModelRegistry & {
  sessionAccount(providerId: string): string | null;
} {
  const models = new Map<string, Model>();
  const sessionAccounts = deps.sessionAccountStore ?? createSessionAccountStore();
  const source = deps.providers ?? configuredProviders(deps.settings);
  const providers = new Map(
    source
      .getAllProviders()
      .map((definition) => [
        definition.id,
        { ...definition, ...(definition.capabilities ? { capabilities: { ...definition.capabilities } } : {}) },
      ]),
  );
  return {
    sessionAccount: (providerId) => getSessionAccount(providerId, sessionAccounts),
    resolve(ref) {
      const key = `${ref.provider}\u0000${ref.model}`;
      const cached = models.get(key);
      if (cached) return cached;
      const provider = providers.get(ref.provider);
      if (!provider?.createStreamedModel) {
        throw new Error(`Provider '${ref.provider}' does not expose an application streamed model.`);
      }
      const model = lazyModel(ref, provider, deps, sessionAccounts);
      if (model.catalogContextWindow === undefined)
        deps.logger.warn(
          `Model context window unknown; automatic compaction assumes ${UNKNOWN_MODEL_CONTEXT_WINDOW.toLocaleString(
            'en-US',
          )} tokens`,
          ref,
        );
      models.set(key, model);
      return model;
    },
    list() {
      return Object.entries(MODEL_CATALOG as Record<string, Record<string, unknown>>).flatMap(([provider, catalog]) =>
        providers.has(provider) ? Object.keys(catalog).map((model) => ({ provider, model })) : [],
      );
    },
  };
}

/** Built-in definitions are fixed; runtime definitions belong only to these settings. */
function configuredProviders(settings: ISettingsService): SourceProviderRegistry {
  const providers = createSourceProviderRegistry();
  for (const configured of decodeStoredCustomProviderConfigs(settings.getDynamic('providers'))) {
    if (providers.getProvider(configured.id) && !providers.getProvider(configured.id)?.isRuntimeDefined) continue;
    if (!configured.baseUrl && !['anthropic', 'google', 'opencode'].includes(configured.type)) continue;
    providers.upsertProvider(
      createOpenAICompatibleProviderDefinition({
        ...configured,
        name: configured.id,
        label: configured.name,
      }),
    );
  }
  return providers;
}

function lazyModel(
  ref: ModelRef,
  provider: ProviderDefinition,
  deps: ProviderRegistryDeps,
  sessionAccountStore: SessionAccountStore,
): Model {
  // A turn shares its state across retries, but concurrent turns never do.
  const compactionByRecovery = new WeakMap<object, ContextCompactionSessionState>();
  const owner = randomUUID();
  const capabilities: ModelCapabilities = {
    continuity: provider.capabilities?.supportsConversationChaining === true,
    standardServiceTier:
      provider.id === 'openai' && !provider.isRuntimeDefined && provider.capabilities?.supportsFlexServiceTier === true,
    httpTransportDowngrade: !provider.isRuntimeDefined && (provider.id === 'openai' || provider.id === 'codex'),
  };
  const variants = new Map<string, Promise<StreamedModelTurn>>();
  const providerContext = new ProviderRequestScope();
  const turnModel = (transport: string): Promise<StreamedModelTurn> => {
    const existing = variants.get(transport);
    if (existing) return existing;
    // Source providers cache by context-service identity. Each model/transport
    // gets an isolated identity and reads only the current explicit request.
    const sessionContext: ISessionContextService = {
      getContext: () => providerContext.getContext(),
      runWithContext: (context, fn) => providerContext.runWithContext(context, fn),
    };
    const created = Promise.resolve()
      .then(() =>
        provider.createStreamedModel!(ref.model, {
          settingsService: factorySettings(deps.settings, transport),
          loggingService: deps.logger,
          sessionContextService: sessionContext,
          onDispatched: () => providerContext.dispatched(),
          sessionAccountStore,
          // No provider RetryingModel: the engine owns retries. The SDK keeps legacy's
          // pre-response retries of one HTTP request (same posts and backoff).
          retryAttempts: 0,
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
    contextWindow: catalogContextWindow ?? UNKNOWN_MODEL_CONTEXT_WINDOW,
    ...(catalogContextWindow !== undefined ? { catalogContextWindow } : {}),
    // Legacy uses Codex's compact endpoint for native compaction; other providers compact locally.
    ...(ref.provider === 'codex'
      ? {
          compact: (request, signal, onDispatched) =>
            providerContext.runWithContext(
              requestTrafficContext(request.affinity, deps.sessionContext?.getContext()),
              () => codexCompact(ref, deps.settings, turnModel)(request, signal, onDispatched),
            ),
        }
      : {}),
    async *stream(request, signal, onDispatched) {
      const transport = request.downgradeTransport ? 'http' : deps.settings.get('agent.transport') ?? 'websocket';
      const identity = requestTrafficContext(request.affinity, deps.sessionContext?.getContext());
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
        const recovery = request.recovery?.budget;
        let compaction = recovery ? compactionByRecovery.get(recovery) : undefined;
        if (!compaction) {
          compaction = { disabled: false };
          if (recovery) compactionByRecovery.set(recovery, compaction);
        }
        const prepared = toProviderRequest(request, signal, {
          provider,
          ref,
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
              const turn = await providerContext.runWithContext(identity, () => turnModel(transport));
              linked.throwIfAborted();
              const projection = new ModelEventProjection(
                ref.provider,
                capabilities.continuity
                  ? { kind: 'direct_response', owner, provider: ref.provider, model: ref.model, transport }
                  : undefined,
              );
              const events = scopeProviderStream(providerContext, identity, onDispatched, (notify) =>
                turn.stream({ ...prepared, signal: linked, onDispatched: notify }),
              );
              for await (const event of events) {
                linked.throwIfAborted();
                yield* projection.project(event);
              }
              projection.finish();
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

function toProviderRequest(
  request: ModelRequest,
  signal: AbortSignal,
  scope: {
    readonly provider: ProviderDefinition;
    readonly ref: ModelRef;
    readonly compaction: ContextCompactionSessionState;
    readonly owner: string;
    readonly transport: string;
    readonly capabilities: ModelCapabilities;
    readonly settings: ISettingsService;
  },
): StreamedModelTurnRequest {
  const { provider, ref, compaction } = scope;
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
  const cacheKey = provider.capabilities?.supportsPromptCacheKey ? request.affinity?.cacheKey : undefined;
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
    contextCompactionState: compaction,
    instructions: request.instructions,
    input: historyToInput(request.input, ref.provider),
    tools: request.tools.map(toolDefinition),
    ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
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

/** Async generator bodies re-enter the request's scope on every consumer step. */
function scopeProviderStream<T>(
  contexts: ProviderRequestScope,
  context: SessionTrafficContext,
  onDispatched: (() => void) | undefined,
  create: (onDispatched: () => void) => AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let dispatched = false;
      const notify = () => {
        if (dispatched) return;
        dispatched = true;
        onDispatched?.();
      };
      const run = <T>(operation: () => T) => contexts.runRequest(context, notify, operation);
      const iterator = run(() => create(notify)[Symbol.asyncIterator]());
      return {
        next: () => run(() => iterator.next()),
        return: (value?: unknown) =>
          run(() => iterator.return?.(value) ?? Promise.resolve({ done: true as const, value })),
      };
    },
  };
}
