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
import {
  fetchModels as sourceFetchModels,
  getModelDefaultReasoningLevel,
  getProviderDefaultReasoningLevel,
  type ScopedModelDiscovery,
} from '../../../../source/services/model-service.js';
import type { StreamedModelTurn } from '../../../../source/contracts/streamed-model-turn.js';
import type { ModelRef } from '../../model/index.js';

export interface SourceModelTransports {
  waitForReadSettlement(signal: AbortSignal): Promise<void>;
  readonly settingsService: ISettingsService;
  hasUnsettledReads(): boolean;
  trackDetachedRead(operation: Promise<unknown>): void;
  original(ref: ModelRef): StreamedModelTurn | Promise<StreamedModelTurn>;
  createIndependent(ref: ModelRef): StreamedModelTurn | Promise<StreamedModelTurn>;
  acquireHelper(
    ref: ModelRef,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): { readonly original: StreamedModelTurn | Promise<StreamedModelTurn>; release(): Promise<void> };
  providerDefinition(providerId: string): ProviderDefinition;
  fetchScopedModels(
    providerId: string,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly import('../../../../source/services/model-service.js').ModelInfo[]>;
  modelDefaultReasoningLevel(
    providerId: string,
    modelId: string,
    settingsService?: ISettingsService,
  ): string | undefined;
  providerDefaultReasoningLevel(providerId: string): string | undefined;
  createScoped(
    ref: ModelRef,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): StreamedModelTurn | Promise<StreamedModelTurn>;
  dispose(): Promise<void>;
}

export interface SourceModelTransportsOptions {
  readonly settingsService: ISettingsService;
  readonly loggingService: ILoggingService;
  readonly sessionContextService?: ISessionContextService;
  readonly retryAttempts?: number;
  readonly requestCapture?: ProviderRequestCapture;
  readonly contextCompactionSessionState?: ContextCompactionSessionState;
  readonly providerRegistry?: ProviderRegistry;
  readonly ownership?: 'owned' | 'borrowed';
  readonly onRetry?: (info?: ProviderRetryInfo) => void;
}

const registryOptions = new WeakMap<SourceModelTransports, SourceModelTransportsOptions>();

/** Fork the source transport pool with independent lifetime and settings-scoped discovery. */
export function forkSourceModelTransports(
  registry: SourceModelTransports,
  settingsService: ISettingsService,
): SourceModelTransports {
  const options = registryOptions.get(registry);
  if (!options) throw new Error('Expected adopted model registry');
  return createSourceModelTransports({ ...options, settingsService });
}

/** Own source transport identities and their deferred disposal for a historical engine graph. */
export function createSourceModelTransports(options: SourceModelTransportsOptions): SourceModelTransports {
  const providerRegistry = options.providerRegistry ?? createProviderRegistry();
  const compactionState = options.contextCompactionSessionState ?? { disabled: false };
  const ownership = options.ownership ?? 'owned';
  const bindings = new Map<string, StreamedModelTurn | Promise<StreamedModelTurn>>();
  const workerIdentities = new Map<StreamedModelTurn, { owned: boolean; borrowed: boolean }>();
  const helperIdentities = new Map<StreamedModelTurn, number>();
  const pendingIdentities = new Set<Promise<unknown>>();
  const closedIdentities = new WeakSet<StreamedModelTurn>();
  const pendingCloses = new Set<Promise<unknown>>();
  const unsettledReads = new Set<Promise<unknown>>();
  const discoveryContexts = new WeakMap<ISettingsService, ScopedModelDiscovery>();
  let disposalRequested = false;
  const disposalController = new AbortController();
  const assertActive = () => {
    if (disposalRequested) throw new Error('Model registry is disposed');
  };
  const closeOnce = (model: StreamedModelTurn) => {
    if (closedIdentities.has(model)) return;
    closedIdentities.add(model);
    const closing = Promise.resolve().then(() =>
      (
        model as StreamedModelTurn & {
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
    ref: ModelRef,
    independent: boolean,
    scoped?: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): StreamedModelTurn | Promise<StreamedModelTurn> => {
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
    const assertOpen = (model: StreamedModelTurn) => {
      if (closedIdentities.has(model)) throw new Error('Provider returned a released model transport');
      return model;
    };
    const original = created instanceof Promise ? created.then(assertOpen) : assertOpen(created);
    return original;
  };
  const bindingFor = (ref: ModelRef) => {
    assertActive();
    const key = `${ref.provider}\u0000${ref.model}`;
    const existing = bindings.get(key);
    if (existing) return existing;
    const binding = makeBinding(ref, false);
    bindings.set(key, binding);
    trackIdentity(Promise.resolve(binding), (model) => {
      const previous = workerIdentities.get(model) ?? { owned: false, borrowed: false };
      workerIdentities.set(model, {
        owned: previous.owned || ownership === 'owned',
        borrowed: previous.borrowed || ownership === 'borrowed',
      });
    });
    if (binding instanceof Promise)
      void binding.catch(() => {
        if (bindings.get(key) === binding) bindings.delete(key);
      });
    return binding;
  };
  const registry: SourceModelTransports = {
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
    original: bindingFor,
    createIndependent: (ref) => makeBinding(ref, true),
    acquireHelper(ref, deps) {
      const binding = makeBinding(ref, true, deps);
      const operation = Promise.resolve(binding);
      let released = false;
      let model: StreamedModelTurn | undefined;
      trackIdentity(operation, (resolved) => {
        model = resolved;
        if (!released) helperIdentities.set(resolved, (helperIdentities.get(resolved) ?? 0) + 1);
        else if (!helperIdentities.has(resolved)) helperIdentities.set(resolved, 0);
      });
      return {
        original: binding,
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
      trackIdentity(Promise.resolve(binding), (model) => {
        const previous = workerIdentities.get(model) ?? { owned: false, borrowed: false };
        workerIdentities.set(model, { ...previous, borrowed: true });
      });
      return binding;
    },
    providerDefinition,
    fetchScopedModels: (providerId, deps) =>
      sourceFetchModels({ ...deps, discovery: discoveryFor(deps.settingsService) }, providerId),
    modelDefaultReasoningLevel: (providerId, modelId, settings = options.settingsService) =>
      getModelDefaultReasoningLevel(providerId, modelId, discoveryFor(settings)),
    providerDefaultReasoningLevel: (providerId) =>
      getProviderDefaultReasoningLevel(providerId, discoveryFor(options.settingsService)),
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
