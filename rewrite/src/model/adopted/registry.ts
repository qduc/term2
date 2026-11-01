import type { ContextCompactionSessionState } from '../../../../source/contracts/streamed-model-turn.js';
import type {
  ILoggingService,
  ISettingsService,
  ISessionContextService,
} from '../../../../source/services/service-interfaces.js';
import type { ProviderDefinition, ProviderRegistry } from '../../../../source/providers/registry.js';
import type { ProviderRequestCapture } from '../../../../source/providers/provider-request-capture.js';
import type { ProviderRetryInfo } from '../../../../source/providers/retrying-model.js';
import { waitForAbortableRead } from '../../../../source/contracts/abort-aware-wait.js';
import { createProviderRegistry, getProvider } from '../../../../source/providers/index.js';
import { getModelContextWindow } from '../../../../source/providers/model-catalog/catalog.js';
import { MODEL_CATALOG } from '../../../../source/providers/model-catalog/catalog.generated.js';
import {
  fetchModels as sourceFetchModels,
  getModelDefaultReasoningLevel,
  getProviderDefaultReasoningLevel,
  type ModelInfo,
  type ScopedModelDiscovery,
} from '../../../../source/services/model-service.js';
import type { AdoptedModelBinding, AdoptedModelRegistry, AdoptedModelRegistryOptions } from './index.js';
import { toModelError } from './conversion.js';
import { observedModelStream } from './stream.js';

const DEFAULT_CONTEXT_WINDOW = 128_000;
const registryOptions = new WeakMap<AdoptedModelRegistry, AdoptedModelRegistryOptions>();

export function forkAdoptedModelRegistry(
  registry: AdoptedModelRegistry,
  settingsService: ISettingsService,
): AdoptedModelRegistry {
  const options = registryOptions.get(registry);
  if (!options) throw new Error('Expected adopted model registry');
  return createAdoptedModelRegistry({ ...options, settingsService });
}

export function createAdoptedModelRegistry(options: AdoptedModelRegistryOptions): AdoptedModelRegistry {
  const providerRegistry = options.providerRegistry ?? createProviderRegistry();
  const compactionState = options.contextCompactionSessionState ?? { disabled: false };
  const ownership = options.ownership ?? 'owned';
  const bindings = new Map<string, AdoptedModelBinding>();
  const workerIdentities = new Map<
    import('../../../../source/contracts/streamed-model-turn.js').StreamedModelTurn,
    { owned: boolean; borrowed: boolean }
  >();
  const helperIdentities = new Map<
    import('../../../../source/contracts/streamed-model-turn.js').StreamedModelTurn,
    number
  >();
  const pendingIdentities = new Set<Promise<unknown>>();
  const closedIdentities = new WeakSet<
    import('../../../../source/contracts/streamed-model-turn.js').StreamedModelTurn
  >();
  const pendingCloses = new Set<Promise<unknown>>();
  const unsettledReads = new Set<Promise<unknown>>();
  const discoveryContexts = new WeakMap<ISettingsService, ScopedModelDiscovery>();
  let disposalRequested = false;
  const disposalController = new AbortController();
  const assertActive = () => {
    if (disposalRequested) throw new Error('Model registry is disposed');
  };
  const closeOnce = (model: import('../../../../source/contracts/streamed-model-turn.js').StreamedModelTurn) => {
    if (closedIdentities.has(model)) return;
    closedIdentities.add(model);
    const closing = Promise.resolve().then(() =>
      (
        model as import('../../../../source/contracts/streamed-model-turn.js').StreamedModelTurn & {
          close?: () => unknown;
        }
      ).close?.(),
    );
    pendingCloses.add(closing);
    void closing.then(
      () => pendingCloses.delete(closing),
      () => pendingCloses.delete(closing),
    );
  };
  const reconcileOwnership = () => {
    if (!disposalRequested || pendingIdentities.size || unsettledReads.size) return;
    for (const [model, worker] of workerIdentities)
      if (worker.owned && !worker.borrowed && (helperIdentities.get(model) ?? 0) === 0) closeOnce(model);
    for (const [model, count] of helperIdentities) if (count === 0 && !workerIdentities.has(model)) closeOnce(model);
  };
  const trackIdentity = <T>(operation: Promise<T>, accept: (value: T) => void) => {
    pendingIdentities.add(operation);
    void operation.then(
      (value) => {
        pendingIdentities.delete(operation);
        accept(value);
        reconcileOwnership();
      },
      () => {
        pendingIdentities.delete(operation);
        reconcileOwnership();
      },
    );
  };
  const providerDefinition = (providerId: string): ProviderDefinition => {
    const provider = getProvider(providerId, providerRegistry);
    if (!provider) throw new Error(`Provider '${providerId}' is not registered.`);
    return provider;
  };
  const discoveryFor = (settings: ISettingsService): ScopedModelDiscovery => {
    assertActive();
    let context = discoveryContexts.get(settings);
    if (!context) {
      context = { providerDefinition, cache: new Map() };
      discoveryContexts.set(settings, context);
    }
    return context;
  };
  const makeBinding = (
    ref: import('../index.js').ModelRef,
    independent: boolean,
    scoped?: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): AdoptedModelBinding => {
    assertActive();
    const provider = getProvider(ref.provider, providerRegistry);
    if (!provider?.createStreamedModel)
      throw new Error(`Provider '${ref.provider}' does not expose an application streamed model.`);
    const created = provider.createStreamedModel(ref.model, {
      settingsService: scoped?.settingsService ?? options.settingsService,
      loggingService: scoped?.loggingService ?? options.loggingService,
      ...(scoped
        ? { ...(scoped.sessionContextService ? { sessionContextService: scoped.sessionContextService } : {}) }
        : independent
        ? {}
        : {
            sessionContextService: options.sessionContextService,
            onRetry: options.onRetry,
            retryAttempts: options.retryAttempts,
            requestCapture: options.requestCapture,
            contextCompactionSessionState: compactionState,
          }),
    });
    const assertOpen = (model: import('../../../../source/contracts/streamed-model-turn.js').StreamedModelTurn) => {
      if (closedIdentities.has(model)) throw new Error('Provider returned a released model transport');
      return model;
    };
    const original = created instanceof Promise ? created.then(assertOpen) : assertOpen(created);
    const model: import('../index.js').Model = {
      ref,
      contextWindow: getModelContextWindow(ref.provider, ref.model) ?? DEFAULT_CONTEXT_WINDOW,
      async *stream(request, signal, onDispatched) {
        try {
          const streamed = await original;
          yield* observedModelStream(streamed, request, ref.provider, signal, onDispatched);
        } catch (error) {
          throw toModelError(error, signal);
        }
      },
    };
    return {
      model,
      original,
      provider,
      providerId: ref.provider,
      supportsConversationChaining: provider.capabilities?.supportsConversationChaining ?? false,
      supportsContextCompaction: provider.capabilities?.supportsContextCompaction === true,
      ownership: scoped ? 'borrowed' : independent ? 'owned' : ownership,
    };
  };
  const bindingFor = (ref: import('../index.js').ModelRef) => {
    assertActive();
    const key = `${ref.provider}\u0000${ref.model}`;
    const existing = bindings.get(key);
    if (existing) return existing;
    const binding = makeBinding(ref, false);
    bindings.set(key, binding);
    trackIdentity(Promise.resolve(binding.original), (model) => {
      const previous = workerIdentities.get(model) ?? { owned: false, borrowed: false };
      workerIdentities.set(model, {
        owned: previous.owned || binding.ownership === 'owned',
        borrowed: previous.borrowed || binding.ownership === 'borrowed',
      });
    });
    if (binding.original instanceof Promise)
      void binding.original.catch(() => {
        if (bindings.get(key) === binding) bindings.delete(key);
      });
    return binding;
  };
  const registry: AdoptedModelRegistry = {
    settingsService: options.settingsService,
    async waitForReadSettlement(signal) {
      assertActive();
      const combined = AbortSignal.any([signal, disposalController.signal]);
      combined.throwIfAborted();
      while (unsettledReads.size) {
        await waitForAbortableRead(
          Promise.allSettled([...unsettledReads]).then(() => undefined),
          combined,
        );
        assertActive();
      }
      combined.throwIfAborted();
    },
    hasUnsettledReads: () => unsettledReads.size > 0,
    trackDetachedRead(operation) {
      if (unsettledReads.has(operation)) return;
      unsettledReads.add(operation);
      void operation.then(
        () => {
          unsettledReads.delete(operation);
          reconcileOwnership();
        },
        () => {
          unsettledReads.delete(operation);
          reconcileOwnership();
        },
      );
    },
    resolve: (ref) => bindingFor(ref).model,
    original: bindingFor,
    createIndependent: (ref) => makeBinding(ref, true),
    acquireHelper(ref, deps) {
      const binding = makeBinding(ref, true, deps);
      const operation = Promise.resolve(binding.original);
      let released = false;
      let model: import('../../../../source/contracts/streamed-model-turn.js').StreamedModelTurn | undefined;
      trackIdentity(operation, (resolved) => {
        model = resolved;
        if (!released) helperIdentities.set(resolved, (helperIdentities.get(resolved) ?? 0) + 1);
        else if (!helperIdentities.has(resolved)) helperIdentities.set(resolved, 0);
      });
      return {
        original: binding.original,
        async release() {
          if (released) return;
          released = true;
          if (model) helperIdentities.set(model, Math.max(0, (helperIdentities.get(model) ?? 1) - 1));
          reconcileOwnership();
          await Promise.allSettled([...pendingCloses]);
        },
      };
    },
    createScoped: (ref, deps) => {
      const binding = makeBinding(ref, true, deps);
      trackIdentity(Promise.resolve(binding.original), (model) => {
        const previous = workerIdentities.get(model) ?? { owned: false, borrowed: false };
        workerIdentities.set(model, { ...previous, borrowed: true });
      });
      return binding;
    },
    providerDefinition,
    fetchModels: (providerId, signal) =>
      sourceFetchModels(
        {
          settingsService: options.settingsService,
          loggingService: options.loggingService,
          signal,
          discovery: discoveryFor(options.settingsService),
        },
        providerId,
      ),
    fetchScopedModels: (providerId, deps) =>
      sourceFetchModels({ ...deps, discovery: discoveryFor(deps.settingsService) }, providerId),
    modelDefaultReasoningLevel: (providerId, modelId, settings = options.settingsService) =>
      getModelDefaultReasoningLevel(providerId, modelId, discoveryFor(settings)),
    providerDefaultReasoningLevel: (providerId) =>
      getProviderDefaultReasoningLevel(providerId, discoveryFor(options.settingsService)),
    list: () =>
      Object.entries(MODEL_CATALOG as Record<string, Record<string, unknown>>).flatMap(([provider, models]) =>
        providerRegistry.getProvider(provider) ? Object.keys(models).map((model) => ({ provider, model })) : [],
      ),
    async dispose() {
      disposalRequested = true;
      disposalController.abort();
      bindings.clear();
      reconcileOwnership();
      await Promise.allSettled([...pendingCloses]);
    },
  };
  registryOptions.set(registry, options);
  return registry;
}
