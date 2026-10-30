import { waitForAbortableRead } from '../../../../source/contracts/abort-aware-wait.js';
import { createProviderRegistry, getProvider } from '../../../../source/providers/index.js';
import { getModelContextWindow } from '../../../../source/providers/model-catalog/catalog.js';
import { MODEL_CATALOG } from '../../../../source/providers/model-catalog/catalog.generated.js';
import { fetchModels as sourceFetchModels, getModelDefaultReasoningLevel, getProviderDefaultReasoningLevel, } from '../../../../source/services/model-service.js';
const DEFAULT_CONTEXT_WINDOW = 128_000;
let nextItemId = 0;
const newItemId = () => `adopted_${Date.now().toString(36)}_${(nextItemId++).toString(36)}`;
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value) {
    return (value || newItemId());
}
function sameJson(left, right) {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    }
    catch {
        return false;
    }
}
function isToolResultParts(value) {
    return (value.length > 0 &&
        value.every((part) => {
            if (part.type === 'text')
                return typeof part.text === 'string';
            if (part.type === 'image') {
                if (!('image' in part))
                    return false;
                const image = part.image;
                if (typeof image === 'string' || image === undefined)
                    return true;
                if (!isRecord(image))
                    return false;
                return (typeof image.id === 'string' ||
                    typeof image.url === 'string' ||
                    typeof image.fileId === 'string' ||
                    typeof image.data === 'string' ||
                    image.data instanceof Uint8Array);
            }
            if (part.type === 'file') {
                if (!('file' in part))
                    return false;
                const file = part.file;
                if (typeof file === 'string')
                    return true;
                if (!isRecord(file))
                    return false;
                return (typeof file.id === 'string' ||
                    typeof file.url === 'string' ||
                    ((typeof file.data === 'string' || file.data instanceof Uint8Array) &&
                        typeof file.mediaType === 'string' &&
                        typeof file.filename === 'string'));
            }
            return false;
        }));
}
function parseArguments(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
function decodeDataImage(image) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(image);
    return match ? { mediaType: match[1], data: match[2] } : undefined;
}
function inputToItem(input, provider) {
    switch (input.type) {
        case 'message': {
            const canRepresentContent = input.content.every((part) => part.type === 'text' || (typeof part.image === 'string' && decodeDataImage(part.image) !== undefined));
            if (input.role === 'system' || !canRepresentContent) {
                return {
                    type: 'provider_input',
                    id: newItemId(),
                    provider,
                    input: input,
                };
            }
            const content = input.content.map((part) => {
                if (part.type === 'text')
                    return { type: 'text', text: part.text };
                const decoded = decodeDataImage(part.image);
                return { type: 'image', ...decoded, ...(part.detail ? { detail: part.detail } : {}) };
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
                callId: input.id,
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
                    input: input,
                };
            }
            return {
                type: 'tool_result',
                id: newItemId(),
                callId: input.id,
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
function itemToInput(item) {
    switch (item.type) {
        case 'provider_input':
            return item.input;
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
                    if (part.type === 'text')
                        return { type: 'text', text: part.text };
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
            const argumentsText = item.rawArguments !== undefined && sameJson(item.input, item.argumentsSnapshot)
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
function outputToItem(output, provider) {
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
                callId: output.id,
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
function toModelError(error, signal) {
    if (isRecord(error) &&
        typeof error.kind === 'string' &&
        typeof error.message === 'string' &&
        typeof error.retryable === 'boolean') {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: signal?.aborted ? 'cancelled' : 'provider', message, retryable: false };
}
function stopReason(reason) {
    if (reason === 'tool_calls' || reason === 'tool_use' || reason === 'function_call')
        return 'tool_use';
    if (reason === 'length' || reason === 'max_tokens')
        return 'max_tokens';
    if (reason === 'content_filter' || reason === 'refusal')
        return 'refusal';
    return 'end_turn';
}
function toProviderRequest(request, signal) {
    const continuation = typeof request.continuation === 'string' ? request.continuation : undefined;
    return {
        instructions: request.instructions,
        ...(request.previousResponseId !== undefined
            ? { previousResponseId: request.previousResponseId }
            : continuation !== undefined
                ? { previousResponseId: continuation }
                : {}),
        input: request.input.map(itemToInput),
        tools: request.tools.map((tool) => tool.modelTool
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
            }),
        ...(request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
        signal,
        ...(request.disableChaining !== undefined ? { disableChaining: request.disableChaining } : {}),
    };
}
async function* modelEvents(original, request, provider, signal) {
    const streamedToolCalls = new Map();
    let completion;
    try {
        for await (const event of original.stream(request)) {
            if (signal.aborted)
                throw new DOMException('The operation was aborted.', 'AbortError');
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
                    const completedToolCalls = new Set();
                    for (const output of event.output) {
                        if (output.type === 'tool_call') {
                            const streamed = streamedToolCalls.get(output.id);
                            if (streamed)
                                completedToolCalls.add(output.id);
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
    }
    catch (error) {
        throw toModelError(error, signal);
    }
}
/** Build the `model/` view over the application's existing provider registry. */
const registryOptions = new WeakMap();
export function forkAdoptedModelRegistry(registry, settingsService) {
    const options = registryOptions.get(registry);
    if (!options)
        throw new Error('Expected adopted model registry');
    return createAdoptedModelRegistry({ ...options, settingsService });
}
export function createAdoptedModelRegistry(options) {
    const providerRegistry = options.providerRegistry ?? createProviderRegistry();
    const compactionState = options.contextCompactionSessionState ?? { disabled: false };
    const ownership = options.ownership ?? 'owned';
    const bindings = new Map();
    const workerIdentities = new Map();
    const helperIdentities = new Map();
    const pendingIdentities = new Set();
    const closedIdentities = new WeakSet();
    const pendingCloses = new Set();
    let disposalRequested = false;
    const disposalController = new AbortController();
    const assertActive = () => {
        if (disposalRequested)
            throw new Error('Model registry is disposed');
    };
    const closeOnce = (model) => {
        if (closedIdentities.has(model))
            return;
        closedIdentities.add(model);
        const closing = Promise.resolve().then(() => model.close?.());
        pendingCloses.add(closing);
        void closing.then(() => pendingCloses.delete(closing), () => pendingCloses.delete(closing));
    };
    const reconcileOwnership = () => {
        if (!disposalRequested || pendingIdentities.size || unsettledReads.size)
            return;
        for (const [model, worker] of workerIdentities) {
            if (worker.owned && !worker.borrowed && (helperIdentities.get(model) ?? 0) === 0)
                closeOnce(model);
        }
        for (const [model, count] of helperIdentities) {
            if (count === 0 && !workerIdentities.has(model))
                closeOnce(model);
        }
    };
    const trackIdentity = (operation, accept) => {
        pendingIdentities.add(operation);
        void operation.then((value) => {
            pendingIdentities.delete(operation);
            accept(value);
            reconcileOwnership();
        }, () => {
            pendingIdentities.delete(operation);
            reconcileOwnership();
        });
    };
    const unsettledReads = new Set();
    const discoveryContexts = new WeakMap();
    const providerDefinition = (providerId) => {
        const provider = getProvider(providerId, providerRegistry);
        if (!provider)
            throw new Error(`Provider '${providerId}' is not registered.`);
        return provider;
    };
    const discoveryFor = (settings) => {
        assertActive();
        let context = discoveryContexts.get(settings);
        if (!context) {
            context = { providerDefinition, cache: new Map() };
            discoveryContexts.set(settings, context);
        }
        return context;
    };
    const makeBinding = (ref, independent, scoped) => {
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
        const assertOpen = (model) => {
            if (closedIdentities.has(model))
                throw new Error('Provider returned a released model transport');
            return model;
        };
        const original = created instanceof Promise ? created.then(assertOpen) : assertOpen(created);
        const contextWindow = getModelContextWindow(ref.provider, ref.model) ?? DEFAULT_CONTEXT_WINDOW;
        const model = {
            ref,
            contextWindow,
            async *stream(request, signal) {
                try {
                    const streamed = await original;
                    yield* modelEvents(streamed, toProviderRequest(request, signal), ref.provider, signal);
                }
                catch (error) {
                    throw toModelError(error, signal);
                }
            },
        };
        const binding = {
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
    const bindingFor = (ref) => {
        assertActive();
        const key = `${ref.provider}\u0000${ref.model}`;
        const existing = bindings.get(key);
        if (existing)
            return existing;
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
                if (bindings.get(key) === binding)
                    bindings.delete(key);
            });
        }
        return binding;
    };
    const registry = {
        settingsService: options.settingsService,
        async waitForReadSettlement(signal) {
            assertActive();
            const combined = AbortSignal.any([signal, disposalController.signal]);
            combined.throwIfAborted();
            while (unsettledReads.size) {
                await waitForAbortableRead(Promise.allSettled([...unsettledReads]).then(() => undefined), combined);
                assertActive();
            }
            combined.throwIfAborted();
        },
        hasUnsettledReads: () => unsettledReads.size > 0,
        trackDetachedRead(operation) {
            if (unsettledReads.has(operation))
                return;
            unsettledReads.add(operation);
            void operation.then(() => {
                unsettledReads.delete(operation);
                reconcileOwnership();
            }, () => {
                unsettledReads.delete(operation);
                reconcileOwnership();
            });
        },
        resolve: (ref) => bindingFor(ref).model,
        original: bindingFor,
        createIndependent: (ref) => makeBinding(ref, true),
        acquireHelper(ref, deps) {
            const binding = makeBinding(ref, true, deps);
            const operation = Promise.resolve(binding.original);
            let released = false;
            let model;
            trackIdentity(operation, (resolved) => {
                model = resolved;
                if (!released)
                    helperIdentities.set(resolved, (helperIdentities.get(resolved) ?? 0) + 1);
                else if (!helperIdentities.has(resolved))
                    helperIdentities.set(resolved, 0);
            });
            return {
                original: binding.original,
                async release() {
                    if (released)
                        return;
                    released = true;
                    if (model)
                        helperIdentities.set(model, Math.max(0, (helperIdentities.get(model) ?? 1) - 1));
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
        fetchModels: (providerId, signal) => sourceFetchModels({
            settingsService: options.settingsService,
            loggingService: options.loggingService,
            signal,
            discovery: discoveryFor(options.settingsService),
        }, providerId),
        fetchScopedModels: (providerId, deps) => sourceFetchModels({ ...deps, discovery: discoveryFor(deps.settingsService) }, providerId),
        modelDefaultReasoningLevel: (providerId, modelId, settings = options.settingsService) => getModelDefaultReasoningLevel(providerId, modelId, discoveryFor(settings)),
        providerDefaultReasoningLevel: (providerId) => getProviderDefaultReasoningLevel(providerId, discoveryFor(options.settingsService)),
        list: () => Object.entries(MODEL_CATALOG).flatMap(([provider, models]) => providerRegistry.getProvider(provider) ? Object.keys(models).map((model) => ({ provider, model })) : []),
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
//# sourceMappingURL=index.js.map