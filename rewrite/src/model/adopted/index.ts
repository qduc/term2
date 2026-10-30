import type {
  ContextCompactionSessionState,
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelTurnOutput,
  StreamedModelTurnRequest,
  StreamedModelToolResultPart,
} from '../../../../source/contracts/streamed-model-turn.js';
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
import type {
  Item,
  ItemId,
  Model,
  ModelError,
  ModelEvent,
  ModelRef,
  ModelRegistry,
  ModelRequest,
  ToolCallId,
} from '../index.js';

export interface AdoptedModelBinding {
  readonly model: Model;
  readonly original: StreamedModelTurn | Promise<StreamedModelTurn>;
  readonly providerId: string;
  readonly supportsConversationChaining: boolean;
  readonly supportsContextCompaction: boolean;
  readonly ownership: 'owned' | 'borrowed';
  /** Source provider metadata is intentionally available only through this adopted binding. */
  readonly provider: ProviderDefinition;
}

export interface AdoptedModelRegistry extends ModelRegistry {
  waitForReadSettlement(signal: AbortSignal): Promise<void>;
  readonly settingsService: ISettingsService;
  hasUnsettledReads(): boolean;
  trackDetachedRead(operation: Promise<unknown>): void;
  original(ref: ModelRef): AdoptedModelBinding;
  createIndependent(ref: ModelRef): AdoptedModelBinding;
  acquireHelper(
    ref: ModelRef,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): { readonly original: StreamedModelTurn | Promise<StreamedModelTurn>; release(): Promise<void> };
  providerDefinition(providerId: string): ProviderDefinition;
  fetchModels(providerId: string, signal?: AbortSignal): Promise<readonly ModelInfo[]>;
  fetchScopedModels(
    providerId: string,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly ModelInfo[]>;
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
  ): AdoptedModelBinding;
  dispose(): Promise<void>;
}

export interface AdoptedModelRegistryOptions {
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

const DEFAULT_CONTEXT_WINDOW = 128_000;
let nextItemId = 0;
const newItemId = (): ItemId => `adopted_${Date.now().toString(36)}_${(nextItemId++).toString(36)}` as ItemId;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value: string | undefined): ItemId {
  return (value || newItemId()) as ItemId;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isToolResultParts(
  value: readonly Readonly<Record<string, unknown>>[],
): value is readonly StreamedModelToolResultPart[] {
  return (
    value.length > 0 &&
    value.every((part) => {
      if (part.type === 'text') return typeof part.text === 'string';
      if (part.type === 'image') {
        if (!('image' in part)) return false;
        const image = part.image;
        if (typeof image === 'string' || image === undefined) return true;
        if (!isRecord(image)) return false;
        return (
          typeof image.id === 'string' ||
          typeof image.url === 'string' ||
          typeof image.fileId === 'string' ||
          typeof image.data === 'string' ||
          image.data instanceof Uint8Array
        );
      }
      if (part.type === 'file') {
        if (!('file' in part)) return false;
        const file = part.file;
        if (typeof file === 'string') return true;
        if (!isRecord(file)) return false;
        return (
          typeof file.id === 'string' ||
          typeof file.url === 'string' ||
          ((typeof file.data === 'string' || file.data instanceof Uint8Array) &&
            typeof file.mediaType === 'string' &&
            typeof file.filename === 'string')
        );
      }
      return false;
    })
  );
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function decodeDataImage(image: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(image);
  return match ? { mediaType: match[1]!, data: match[2]! } : undefined;
}

function inputToItem(input: StreamedModelTurnInput, provider: string): Item {
  switch (input.type) {
    case 'message': {
      const canRepresentContent = input.content.every(
        (part) => part.type === 'text' || (typeof part.image === 'string' && decodeDataImage(part.image) !== undefined),
      );
      if (input.role === 'system' || !canRepresentContent) {
        return {
          type: 'provider_input',
          id: newItemId(),
          provider,
          input: input as unknown as Readonly<Record<string, unknown>>,
        };
      }
      const content = input.content.map((part) => {
        if (part.type === 'text') return { type: 'text' as const, text: part.text };
        const decoded = decodeDataImage(part.image as string)!;
        return { type: 'image' as const, ...decoded, ...(part.detail ? { detail: part.detail } : {}) };
      });
      return input.role === 'user'
        ? { type: 'user_message', id: newItemId(), content }
        : { type: 'assistant_message', id: newItemId(), content };
    }
    case 'reasoning':
      return {
        type: 'reasoning',
        id: id(input.id),
        ...(input.id !== undefined ? { providerItemId: input.id } : {}),
        summary: input.text,
        ...(input.providerMetadata ? { providerMetadata: input.providerMetadata } : {}),
      };
    case 'tool_call': {
      const parsed = parseArguments(input.arguments);
      return {
        type: 'tool_call',
        id: id(input.id),
        callId: input.id as ToolCallId,
        toolName: input.name,
        input: parsed,
        rawArguments: input.arguments,
        argumentsSnapshot: parsed,
        ...(input.providerMetadata ? { providerMetadata: input.providerMetadata } : {}),
        ...(input.toolType ? { toolType: input.toolType } : {}),
      };
    }
    case 'tool_result':
      if (typeof input.output !== 'string') {
        return {
          type: 'provider_input',
          id: newItemId(),
          provider,
          input: input as unknown as Readonly<Record<string, unknown>>,
        };
      }
      return {
        type: 'tool_result',
        id: newItemId(),
        callId: input.id as ToolCallId,
        output: input.output,
        isError: false,
        ...(input.toolType ? { toolType: input.toolType } : {}),
      };
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        id: newItemId(),
        provider: input.provider,
        ...(input.sourceProvider ? { sourceProvider: input.sourceProvider } : {}),
        item: input.item,
      };
  }
}

function itemToInput(item: Item): StreamedModelTurnInput {
  switch (item.type) {
    case 'provider_input':
      return item.input as unknown as StreamedModelTurnInput;
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        provider: item.provider,
        ...(item.sourceProvider ? { sourceProvider: item.sourceProvider } : {}),
        item: item.item,
      };
    case 'user_message':
    case 'assistant_message':
      return {
        type: 'message',
        role: item.type === 'user_message' ? 'user' : 'assistant',
        content: item.content.map((part) => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          return {
            type: 'image',
            image: `data:${part.mediaType};base64,${part.data}`,
            ...(part.detail ? { detail: part.detail } : {}),
          };
        }),
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        ...(item.providerItemId !== undefined ? { id: item.providerItemId } : {}),
        text: item.summary,
        ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
      };
    case 'tool_call': {
      const argumentsText =
        item.rawArguments !== undefined && sameJson(item.input, item.argumentsSnapshot)
          ? item.rawArguments
          : JSON.stringify(item.input ?? {});
      return {
        type: 'tool_call',
        id: item.callId,
        name: item.toolName,
        arguments: argumentsText ?? 'null',
        ...(item.toolType ? { toolType: item.toolType } : {}),
        ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
      };
    }
    case 'tool_result':
      return {
        type: 'tool_result',
        id: item.callId,
        output: item.providerOutput && isToolResultParts(item.providerOutput) ? item.providerOutput : item.output,
        ...(item.toolType ? { toolType: item.toolType } : {}),
      };
    case 'summary':
      return { type: 'message', role: 'user', content: [{ type: 'text', text: item.text }] };
  }
}

function outputToItem(
  output: StreamedModelTurnOutput | Extract<StreamedModelTurnEvent, { type: 'tool_call' }>,
  provider: string,
): Item {
  switch (output.type) {
    case 'message':
      return { type: 'assistant_message', id: newItemId(), content: output.content.map((part) => ({ ...part })) };
    case 'reasoning':
      return {
        type: 'reasoning',
        id: id(output.id),
        ...(output.id !== undefined ? { providerItemId: output.id } : {}),
        summary: output.text,
        ...(output.providerMetadata ? { providerMetadata: output.providerMetadata } : {}),
      };
    case 'tool_call': {
      const parsed = parseArguments(output.arguments);
      return {
        type: 'tool_call',
        id: id(output.id),
        callId: output.id as ToolCallId,
        toolName: output.name,
        input: parsed,
        rawArguments: output.arguments,
        argumentsSnapshot: parsed,
        ...(output.providerMetadata ? { providerMetadata: output.providerMetadata } : {}),
        ...('toolType' in output && output.toolType ? { toolType: output.toolType } : {}),
      };
    }
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        id: newItemId(),
        provider: output.provider || provider,
        ...(output.sourceProvider ? { sourceProvider: output.sourceProvider } : {}),
        item: output.item,
      };
  }
}

function toModelError(error: unknown, signal?: AbortSignal): ModelError {
  if (
    isRecord(error) &&
    typeof error.kind === 'string' &&
    typeof error.message === 'string' &&
    typeof error.retryable === 'boolean'
  ) {
    return error as unknown as ModelError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: signal?.aborted ? 'cancelled' : 'provider', message, retryable: false };
}

function stopReason(reason: string | undefined): 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' {
  if (reason === 'tool_calls' || reason === 'tool_use' || reason === 'function_call') return 'tool_use';
  if (reason === 'length' || reason === 'max_tokens') return 'max_tokens';
  if (reason === 'content_filter' || reason === 'refusal') return 'refusal';
  return 'end_turn';
}

function toProviderRequest(request: ModelRequest, signal: AbortSignal): StreamedModelTurnRequest {
  const continuation = typeof request.continuation === 'string' ? request.continuation : undefined;
  return {
    instructions: request.instructions,
    ...(request.previousResponseId !== undefined
      ? { previousResponseId: request.previousResponseId }
      : continuation !== undefined
      ? { previousResponseId: continuation }
      : {}),
    input: request.input.map(itemToInput),
    tools: request.tools.map((tool) =>
      tool.modelTool
        ? {
            type: tool.modelTool.type,
            name: tool.name,
            description: tool.description,
            format: tool.modelTool.format,
          }
        : {
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
    ),
    ...(request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
    signal,
    ...(request.disableChaining !== undefined ? { disableChaining: request.disableChaining } : {}),
  };
}

async function* modelEvents(
  original: StreamedModelTurn,
  request: StreamedModelTurnRequest,
  provider: string,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const streamedToolCalls = new Map<string, Extract<StreamedModelTurnEvent, { type: 'tool_call' }>>();
  let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;
  try {
    for await (const event of original.stream(request)) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      switch (event.type) {
        case 'text_delta':
          yield { type: 'text_delta', delta: event.text, ...(event.partId ? { partId: event.partId } : {}) };
          break;
        case 'reasoning_delta':
          yield {
            type: 'reasoning_delta',
            delta: event.text,
            ...(event.id ? { id: event.id } : {}),
            ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
          };
          break;
        case 'tool_call': {
          // Completion output is authoritative for the full call. Keep the event as a fallback
          // until that output arrives so late provider metadata/final arguments are not lost.
          streamedToolCalls.set(event.id, event);
          break;
        }
        case 'completion':
          completion = event;
          if (event.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: event.usage.inputTokens ?? 0,
                outputTokens: event.usage.outputTokens ?? 0,
                cachedInputTokens: event.usage.cachedInputTokens ?? 0,
              },
            };
          }
          const completedToolCalls = new Set<string>();
          for (const output of event.output) {
            if (output.type === 'tool_call') {
              const streamed = streamedToolCalls.get(output.id);
              if (streamed) completedToolCalls.add(output.id);
              const completeCall = streamed
                ? {
                    ...streamed,
                    ...output,
                    ...(output.providerMetadata !== undefined || streamed.providerMetadata === undefined
                      ? {}
                      : { providerMetadata: streamed.providerMetadata }),
                    ...(streamed.toolType ? { toolType: streamed.toolType } : {}),
                  }
                : output;
              yield { type: 'item', item: outputToItem(completeCall, provider) };
              continue;
            }
            yield { type: 'item', item: outputToItem(output, provider) };
          }
          for (const [callId, streamed] of streamedToolCalls) {
            if (!completedToolCalls.has(callId)) {
              yield { type: 'item', item: outputToItem(streamed, provider) };
            }
          }
          yield {
            type: 'done',
            stopReason: stopReason(event.finishReason),
            continuation: event.responseId,
            ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          };
          break;
        default:
          break;
      }
    }
    if (!completion) {
      for (const streamed of streamedToolCalls.values()) {
        yield { type: 'item', item: outputToItem(streamed, provider) };
      }
      yield { type: 'done', stopReason: 'end_turn' };
    }
  } catch (error) {
    throw toModelError(error, signal);
  }
}

type CachedBinding = AdoptedModelBinding;

/** Build the `model/` view over the application's existing provider registry. */
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
  const bindings = new Map<string, CachedBinding>();
  const workerIdentities = new Map<StreamedModelTurn, { owned: boolean; borrowed: boolean }>();
  const helperIdentities = new Map<StreamedModelTurn, number>();
  const pendingIdentities = new Set<Promise<unknown>>();
  const closedIdentities = new WeakSet<StreamedModelTurn>();
  const pendingCloses = new Set<Promise<unknown>>();
  let disposalRequested = false;
  const disposalController = new AbortController();
  const assertActive = () => {
    if (disposalRequested) throw new Error('Model registry is disposed');
  };
  const closeOnce = (model: StreamedModelTurn) => {
    if (closedIdentities.has(model)) return;
    closedIdentities.add(model);
    const closing = Promise.resolve().then(() => (model as StreamedModelTurn & { close?: () => unknown }).close?.());
    pendingCloses.add(closing);
    void closing.then(
      () => pendingCloses.delete(closing),
      () => pendingCloses.delete(closing),
    );
  };
  const reconcileOwnership = () => {
    if (!disposalRequested || pendingIdentities.size || unsettledReads.size) return;
    for (const [model, worker] of workerIdentities) {
      if (worker.owned && !worker.borrowed && (helperIdentities.get(model) ?? 0) === 0) closeOnce(model);
    }
    for (const [model, count] of helperIdentities) {
      if (count === 0 && !workerIdentities.has(model)) closeOnce(model);
    }
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
  const unsettledReads = new Set<Promise<unknown>>();
  const discoveryContexts = new WeakMap<ISettingsService, ScopedModelDiscovery>();
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
  ): AdoptedModelBinding => {
    assertActive();
    const provider = getProvider(ref.provider, providerRegistry);
    if (!provider?.createStreamedModel) {
      throw new Error(`Provider '${ref.provider}' does not expose an application streamed model.`);
    }
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
    const assertOpen = (model: StreamedModelTurn): StreamedModelTurn => {
      if (closedIdentities.has(model)) throw new Error('Provider returned a released model transport');
      return model;
    };
    const original = created instanceof Promise ? created.then(assertOpen) : assertOpen(created);
    const contextWindow = getModelContextWindow(ref.provider, ref.model) ?? DEFAULT_CONTEXT_WINDOW;
    const model: Model = {
      ref,
      contextWindow,
      async *stream(request, signal) {
        try {
          const streamed = await original;
          yield* modelEvents(streamed, toProviderRequest(request, signal), ref.provider, signal);
        } catch (error) {
          throw toModelError(error, signal);
        }
      },
    };
    const binding: AdoptedModelBinding = {
      model,
      original,
      provider,
      providerId: ref.provider,
      supportsConversationChaining: provider.capabilities?.supportsConversationChaining ?? false,
      supportsContextCompaction: provider.capabilities?.supportsContextCompaction === true,
      ownership: scoped ? 'borrowed' : independent ? 'owned' : ownership,
    };
    return binding;
  };

  const bindingFor = (ref: ModelRef): AdoptedModelBinding => {
    assertActive();
    const key = `${ref.provider}\u0000${ref.model}`;
    const existing = bindings.get(key);
    if (existing) return existing;
    const binding = makeBinding(ref, false);
    bindings.set(key, binding);
    const worker = Promise.resolve(binding.original);
    trackIdentity(worker, (model) => {
      const previous = workerIdentities.get(model) ?? { owned: false, borrowed: false };
      workerIdentities.set(model, {
        owned: previous.owned || binding.ownership === 'owned',
        borrowed: previous.borrowed || binding.ownership === 'borrowed',
      });
    });
    if (binding.original instanceof Promise) {
      void binding.original.catch(() => {
        if (bindings.get(key) === binding) bindings.delete(key);
      });
    }
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
      let model: StreamedModelTurn | undefined;
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

export const adoptedModelConversion = {
  inputToItem,
  itemToInput,
  outputToItem,
};
