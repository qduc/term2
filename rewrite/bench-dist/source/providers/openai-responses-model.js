import { OPENAI_RESPONSES_OPAQUE_TAG, isForeignProviderOpaque } from './provider-opaque-compatibility.js';
import { consumeOpenAIRequestPrefixBindingWithOutcome } from './openai-request-prefix-binding.js';
import { observeOpenAIRequestLifecycle } from './provider-request-capture.js';
import { randomUUID } from 'node:crypto';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { getModelContextWindow } from './model-catalog/catalog.js';
import { ResponsesWebSocketSessions } from './responses-websocket-sessions.js';
import { WebSocketClosedEarlyError, readWebSocketCloseFrame } from './websocket-close-evidence.js';
import { raceWebSocketAbort } from './websocket-abort-race.js';
import { filterChainedModelInput } from '../lib/chained-input-filter.js';
const endpointOf = (client) => {
    const value = client?.baseURL ?? client?._options?.baseURL;
    return typeof value === 'string' && value ? value.replace(/\/$/, '') : 'https://api.openai.com/v1';
};
class Lifecycle {
    #attempts = new WeakMap();
    begin(request, transport, model, client) {
        this.#attempts.set(request, {
            token: randomUUID(),
            provider: 'openai',
            transport,
            model,
            endpoint: endpointOf(client),
            requestData: {},
        });
    }
    bind(request, capture) {
        const attempt = this.#attempts.get(request);
        if (!attempt)
            return;
        try {
            attempt.requestData = { input: structuredClone(request.input) };
            const binding = consumeOpenAIRequestPrefixBindingWithOutcome(request.input);
            attempt.prefixBinding = binding.binding;
            attempt.prefixBindingOutcome = binding.outcome;
            observeOpenAIRequestLifecycle(capture, { ...attempt, phase: 'request-built' });
        }
        catch {
            /* lifecycle observation is non-authoritative */
        }
    }
    finish(request, phase, capture, responseId) {
        const attempt = this.#attempts.get(request);
        if (!attempt)
            return;
        this.#attempts.delete(request);
        observeOpenAIRequestLifecycle(capture, { ...attempt, phase, ...(responseId ? { responseId } : {}) });
    }
}
/**
 * Build the Responses image_url/file_id reference for an application image
 * reference, or `undefined` when the reference carries nothing sendable.
 */
function toResponsesImageReference(image) {
    if (typeof image === 'string')
        return { image_url: image };
    if (!image || typeof image !== 'object')
        return undefined;
    const record = image;
    if (typeof record.id === 'string' || typeof record.fileId === 'string') {
        return { file_id: typeof record.fileId === 'string' ? record.fileId : record.id };
    }
    if (typeof record.url === 'string')
        return { image_url: record.url };
    if (typeof record.data === 'string' || record.data instanceof Uint8Array) {
        const data = typeof record.data === 'string' ? record.data : Buffer.from(record.data).toString('base64');
        const mediaType = typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream';
        return { image_url: `data:${mediaType};base64,${data}` };
    }
    return undefined;
}
/** Placeholder text for a content part we cannot represent on the wire. */
const unsupportedPartText = (role, description) => ({
    type: role === 'assistant' ? 'output_text' : 'input_text',
    text: `[unsupported ${description} omitted]`,
});
function toResponsesApiContentPart(role, part) {
    if (part?.type === 'image') {
        const reference = toResponsesImageReference(part.image);
        // An `input_image` with neither image_url nor file_id is malformed and
        // fails the whole request. Describe it as text rather than sending it.
        if (!reference)
            return unsupportedPartText(role, 'image content');
        return { type: 'input_image', ...reference, detail: part.detail ?? 'auto' };
    }
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part?.text ?? '' };
}
/**
 * Build the Responses file reference for an application file reference, or
 * `undefined` when the reference carries nothing sendable. Inline file data
 * needs a filename; without one there is no valid `input_file` to build.
 */
function toResponsesFileReference(file) {
    if (typeof file === 'string')
        return { file_id: file };
    if (!file || typeof file !== 'object')
        return undefined;
    const record = file;
    const filename = typeof record.filename === 'string' ? { filename: record.filename } : {};
    if (typeof record.id === 'string')
        return { file_id: record.id, ...filename };
    if (typeof record.url === 'string')
        return { file_url: record.url, ...filename };
    if ((typeof record.data === 'string' || record.data instanceof Uint8Array) && typeof record.filename === 'string') {
        return {
            file_data: typeof record.data === 'string' ? record.data : Buffer.from(record.data).toString('base64'),
            filename: record.filename,
        };
    }
    return undefined;
}
/** Convert one application tool-result part to a Responses output part. */
function toResponsesToolResultPart(part) {
    if (typeof part === 'string')
        return { type: 'input_text', text: part };
    if (part?.type === 'image') {
        const reference = toResponsesImageReference(part.image);
        // Degrade to text rather than emitting a reference-less `input_image`,
        // which the API rejects and which would fail the continuation turn.
        if (!reference)
            return unsupportedPartText('tool', 'image content');
        return {
            type: 'input_image',
            ...reference,
            ...(part.detail ? { detail: part.detail } : {}),
        };
    }
    if (part?.type === 'file') {
        const reference = toResponsesFileReference(part.file);
        if (!reference)
            return unsupportedPartText('tool', 'file content');
        return { type: 'input_file', ...reference };
    }
    return { type: 'input_text', text: part?.text ?? '' };
}
function toResponsesApiOutput(output) {
    if (typeof output === 'string')
        return output;
    // A multimodal content-part array (read_file images) becomes Responses
    // output parts so the image reaches the model; JSON-stringifying it would
    // deliver a text blob instead of the image.
    if (Array.isArray(output))
        return output.map(toResponsesToolResultPart);
    // Tool execution historically supplied structured values. Keep the
    // application result wrapped under `text` when serializing those values so
    // continuation requests remain byte-for-byte compatible with the old wire
    // projection while typed string results stay plain text.
    return JSON.stringify({ text: output ?? '' });
}
function toResponsesApiInput(input, lane = OPENAI_RESPONSES_OPAQUE_TAG) {
    // An opaque item from another lane is inert baggage left by a provider
    // switch, not a fault: it is dropped so the rest of the history still
    // replays. See `provider-opaque-compatibility.ts`.
    const replayable = input.filter((item) => !isForeignProviderOpaque(item, lane));
    return replayable.map((item) => {
        if (item?.type === 'message') {
            return {
                type: 'message',
                role: item.role,
                content: typeof item.content === 'string'
                    ? item.content
                    : (item.content ?? []).map((part) => toResponsesApiContentPart(item.role, part)),
            };
        }
        if (item?.type === 'tool_call') {
            return item.toolType === 'custom'
                ? { type: 'custom_tool_call', call_id: item.id, name: item.name, input: item.arguments }
                : { type: 'function_call', call_id: item.id, name: item.name, arguments: item.arguments };
        }
        if (item?.type === 'tool_result') {
            return item.toolType === 'custom'
                ? { type: 'custom_tool_call_output', call_id: item.id, output: toResponsesApiOutput(item.output) }
                : { type: 'function_call_output', call_id: item.id, output: toResponsesApiOutput(item.output) };
        }
        if (item?.type === 'reasoning') {
            // Read only this lane's key: a sibling lane's blob is another vendor's
            // ciphertext, and sending it would fail the turn.
            const metadata = item.providerMetadata?.[lane];
            const legacyEncryptedContent = lane === OPENAI_RESPONSES_OPAQUE_TAG ? item.providerMetadata?.encrypted_content : undefined;
            const encryptedContent = metadata?.encrypted_content ?? legacyEncryptedContent;
            return {
                type: 'reasoning',
                ...(item.id ? { id: item.id } : {}),
                summary: item.text ? [{ type: 'summary_text', text: item.text }] : [],
                ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
            };
        }
        if (item?.type === 'provider_opaque') {
            // Foreign tags were filtered above; anything reaching here is our own.
            return item.item;
        }
        return item;
    });
}
function toResponsesToolChoice(choice, tools) {
    if (choice === 'auto' || choice === 'required' || choice === 'none')
        return choice;
    const selected = tools.find((tool) => tool.name === choice.name);
    return { type: selected?.type === 'custom' ? 'custom' : 'function', name: choice.name };
}
function toResponsesApiTool(tool) {
    if (tool.type === 'custom') {
        return {
            type: 'custom',
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            format: tool.format,
        };
    }
    return {
        type: 'function',
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    };
}
function toResponsesOutputFormat(outputType) {
    return {
        format: {
            type: 'json_schema',
            name: outputType.name,
            strict: outputType.strict,
            schema: outputType.schema,
        },
    };
}
/** Shared allowlist for Responses `context_management` (OpenAI + Codex). */
export function supportsContextCompactionModel(model) {
    // Server-side context_management is model-dependent: gpt-5.1/gpt-5.2 returned
    // opaque 500s when the threshold fired (docs/plans/context-and-memory/openai-context-compaction.md).
    // OpenAI's compaction guide demos gpt-5.3-codex; the compact endpoint enum and
    // product usage cover gpt-5.5 and the full gpt-5.6 family (sol/terra/luna).
    // Default-deny unmeasured families (e.g. bare gpt-5.3, gpt-5.10).
    // Re-measure before adding a new family.
    return /^(?:gpt-5\.(?:4|5|6)(?:$|[-_])|gpt-5\.3-codex(?:$|[-_]))/.test(model);
}
function contextCompaction(providerOptions, model, providerSupportsContextCompaction, sessionState) {
    if (sessionState?.disabled || !providerSupportsContextCompaction || !supportsContextCompactionModel(model))
        return undefined;
    const option = providerOptions?.contextCompaction;
    if (option?.enabled !== true ||
        typeof option.threshold !== 'number' ||
        !Number.isFinite(option.threshold) ||
        option.threshold < 0 ||
        option.threshold > 1) {
        return undefined;
    }
    // Catalog keys are shared across OpenAI and Codex model ids.
    const contextWindow = getModelContextWindow('openai', model) ?? getModelContextWindow('codex', model);
    if (!contextWindow)
        return undefined;
    // The setting is a fraction of the selected model's context window. The
    // Responses API still accepts an integer token count and enforces a 1000
    // token minimum, so apply that provider-specific conversion at the wire
    // boundary rather than exposing model-specific token counts in settings.
    const ratioThreshold = Math.max(1000, Math.round(contextWindow * option.threshold));
    const thresholdTokens = typeof option.thresholdTokens === 'number' &&
        Number.isInteger(option.thresholdTokens) &&
        option.thresholdTokens >= 1000
        ? option.thresholdTokens
        : undefined;
    return { threshold: thresholdTokens === undefined ? ratioThreshold : Math.min(ratioThreshold, thresholdTokens) };
}
/** Wire shape for `context_management`, or undefined when gated off. */
function resolveContextManagement(providerOptions, model, providerSupportsContextCompaction, sessionState) {
    const compaction = contextCompaction(providerOptions, model, providerSupportsContextCompaction, sessionState);
    if (!compaction)
        return undefined;
    return [{ type: 'compaction', compact_threshold: compaction.threshold }];
}
function requestBody(request, model, stream, providerSupportsContextCompaction = false, sessionState, lane = OPENAI_RESPONSES_OPAQUE_TAG) {
    const providerOptions = request.providerOptions ?? {};
    // context_management is capability-gated below. Do not let the generic
    // extra-body escape hatch bypass that gate on unsupported endpoints/models.
    const { context_management: _reservedContextManagement, ...extraBody } = providerOptions.extraBody ?? {};
    const contextManagement = resolveContextManagement(providerOptions, model, providerSupportsContextCompaction, sessionState);
    const modelInput = request.previousResponseId
        ? filterChainedModelInput({ input: request.input }).input
        : request.input;
    const projectedInput = toResponsesApiInput(modelInput, lane);
    const body = {
        model,
        input: projectedInput,
        stream,
        ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
        ...((request.tools ?? []).length ? { tools: (request.tools ?? []).map(toResponsesApiTool) } : {}),
        ...(request.toolChoice !== undefined
            ? { tool_choice: toResponsesToolChoice(request.toolChoice, request.tools ?? []) }
            : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
        ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
        ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
        ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
        ...(request.outputType && request.outputType !== 'text'
            ? { text: toResponsesOutputFormat(request.outputType) }
            : {}),
        ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        ...extraBody,
        ...(contextManagement ? { context_management: contextManagement } : {}),
    };
    // Encrypted reasoning is only returned when explicitly requested by the
    // Responses API. Merge this provider requirement with caller/extra-body
    // includes rather than replacing or duplicating either source.
    const existingInclude = [body.include, providerOptions.include].filter(Array.isArray).flat();
    body.include = Array.from(new Set([...existingInclude, 'reasoning.encrypted_content']));
    return body;
}
function normalizeUsage(usage) {
    if (!usage)
        return undefined;
    const inputTokens = usage.input_tokens ?? usage.inputTokens;
    const outputTokens = usage.output_tokens ?? usage.outputTokens;
    const cachedInputTokens = usage.input_tokens_details?.cached_tokens ?? usage.cachedInputTokens;
    const cacheWriteTokens = usage.input_tokens_details?.cache_creation_tokens ?? usage.cacheWriteTokens;
    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ??
        usage.outputTokensDetails?.reasoningTokens ??
        usage.outputTokensDetails?.reasoning_tokens;
    return {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    };
}
function reasoningText(item) {
    const summary = item?.summary ?? item?.content ?? item?.rawContent;
    if (typeof summary === 'string')
        return summary;
    if (!Array.isArray(summary))
        return '';
    return summary
        .filter((part) => part?.type === 'summary_text' || part?.type === 'reasoning_text' || part?.type === 'text')
        .map((part) => String(part.text ?? ''))
        .join('');
}
function reasoningMetadata(item, lane) {
    const directMetadata = item?.providerData ?? item?.provider_metadata ?? item?.provider_data;
    const nested = directMetadata?.[lane];
    const encryptedContent = item?.encrypted_content ?? nested?.encrypted_content ?? directMetadata?.encrypted_content;
    if (encryptedContent === undefined)
        return undefined;
    return { [lane]: { encrypted_content: encryptedContent } };
}
function toTurnOutput(item, lane = OPENAI_RESPONSES_OPAQUE_TAG) {
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
        return {
            type: 'tool_call',
            id: item.call_id ?? item.callId,
            name: item.name,
            arguments: item.type === 'custom_tool_call' ? item.input ?? '' : item.arguments ?? '{}',
            ...(item.type === 'custom_tool_call' ? { toolType: 'custom' } : {}),
        };
    }
    if (item?.type === 'message') {
        const content = Array.isArray(item.content) ? item.content : [];
        return {
            type: 'message',
            content: content
                .filter((part) => part?.type === 'output_text' || part?.type === 'text')
                .map((part) => ({ type: 'text', text: String(part.text ?? '') })),
        };
    }
    if (item?.type === 'reasoning') {
        const providerMetadata = reasoningMetadata(item, lane);
        return {
            type: 'reasoning',
            ...(item.id ? { id: String(item.id) } : {}),
            text: reasoningText(item),
            ...(providerMetadata ? { providerMetadata } : {}),
        };
    }
    // Anything else is provider-native and opaque: carry it through untouched
    // rather than failing the turn. Compaction items are the first such type;
    // future Responses item kinds flow the same way.
    return {
        type: 'provider_opaque',
        provider: lane,
        sourceProvider: lane,
        item,
    };
}
export function contextCompactionFailureCategory(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const record = error;
    const status = Number(record.status ?? record.statusCode ?? record.error?.status);
    const text = JSON.stringify(error);
    // Every branch requires explicit context-management evidence. `server_error` alone is
    // OpenAI's generic 5xx marker and also appears on transport/provider failures that have
    // nothing to do with compaction (e.g. an in-band Codex `server_error` frame on a long
    // chained request). Matching it here misattributes the failure as a compaction failure
    // and, via markContextCompactionFailure, disables compaction for the whole session.
    if (status === 500 && /context[_ ]management/i.test(text))
        return 'request';
    if (status === 400 && /unsupported_value/i.test(text) && /context[_ ]management/i.test(text))
        return 'request';
    if (status === 400 && /integer_below_min_value|compact_threshold|context[_ ]management/i.test(text))
        return 'validation';
    return undefined;
}
export function markContextCompactionFailure(error, request, sessionState) {
    if (!request.providerOptions || !request.providerOptions.contextCompaction)
        return;
    const category = contextCompactionFailureCategory(error);
    if (!category)
        return;
    if (category === 'request' && sessionState)
        sessionState.disabled = true;
    if (error && typeof error === 'object') {
        Object.defineProperty(error, 'contextCompactionFailure', { value: category, configurable: true });
    }
}
function responseStatusError(status, response) {
    const providerError = response?.error;
    const detail = providerError?.message ??
        providerError?.code ??
        response?.incomplete_details?.reason ??
        response?.incompleteDetails?.reason ??
        response?.status;
    return new Error(`OpenAI response response.${status}${detail ? ` (${String(detail)})` : ''}${response?.id ? ` [${response.id}]` : ''}`);
}
function assertUnaryResponseCompleted(response) {
    if (response?.status === 'failed' || response?.status === 'incomplete') {
        throw responseStatusError(response.status, response);
    }
}
function completedEvent(response, lane = OPENAI_RESPONSES_OPAQUE_TAG) {
    return {
        type: 'completion',
        responseId: response?.id ?? response?.responseId ?? `response-${Date.now()}`,
        output: (response?.output ?? []).map((item) => toTurnOutput(item, lane)),
        usage: normalizeUsage(response?.usage),
        ...(response?.status ? { finishReason: response.status } : {}),
    };
}
export function createResponseEventNormalizationState() {
    return {
        toolNamesByIndex: new Map(),
        toolArgumentLengthsByIndex: new Map(),
        reasoningEmittedItemIds: new Set(),
        compactionStartedAtByIndex: new Map(),
    };
}
/**
 * Pairing key for a compaction item's `added`/`done` frames. A response carries more than
 * one compaction item, so the key must distinguish them: `output_index` does, and the item
 * id is the fallback for shims that omit it.
 */
function compactionIndex(event, item) {
    if (typeof event.output_index === 'number')
        return event.output_index;
    return typeof item?.id === 'string' ? item.id : 0;
}
/** Convert a Responses `output_text.delta` into a text delta tagged with its message part. */
export function responsesTextDelta(event) {
    const text = String(event?.delta ?? '');
    if (typeof event?.item_id !== 'string')
        return { type: 'text_delta', text };
    const contentIndex = typeof event.content_index === 'number' ? event.content_index : 0;
    return { type: 'text_delta', partId: `${event.item_id}:${contentIndex}`, text };
}
/** Convert one native OpenAI Responses event to the application turn protocol. */
export function normalizeResponseEvent(event, state = createResponseEventNormalizationState(), lane = OPENAI_RESPONSES_OPAQUE_TAG) {
    if (!event || typeof event.type !== 'string')
        return null;
    if (event.type === 'response.output_text.delta')
        return responsesTextDelta(event);
    const reasoningDelta = (id, text) => {
        if (!text)
            return null;
        if (id !== undefined)
            state.reasoningEmittedItemIds.add(id);
        return { type: 'reasoning_delta', ...(id !== undefined ? { id } : {}), text };
    };
    // OpenAI-compatible servers emit reasoning under a few different delta names.
    // opencode's /v1/responses shim streams response.reasoning_text.delta while
    // OpenAI's own Responses API uses response.reasoning_summary_text.delta.
    if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
        return reasoningDelta(event.item_id, String(event.delta ?? ''));
    }
    // Summary parts carry the reasoning text in part.text. Added/delta events are
    // incremental; done can repeat the complete text, so only emit it when no
    // earlier part for the item was observed.
    if (event.type === 'response.reasoning_summary_part.added' ||
        event.type === 'response.reasoning_summary_part.delta') {
        const text = typeof event.part?.text === 'string' ? event.part.text : '';
        const id = typeof event.item_id === 'string' ? event.item_id : undefined;
        if (!text && event.type === 'response.reasoning_summary_part.added') {
            return { type: 'reasoning_started', ...(id !== undefined ? { id } : {}) };
        }
        return reasoningDelta(id, text);
    }
    if (event.type === 'response.reasoning_summary_part.done') {
        const text = typeof event.part?.text === 'string' ? event.part.text : '';
        const id = typeof event.item_id === 'string' ? event.item_id : undefined;
        if (!text || (id !== undefined && state.reasoningEmittedItemIds.has(id)))
            return null;
        return reasoningDelta(id, text);
    }
    if (event.type === 'response.output_item.added') {
        const item = event.output_item ?? event.item;
        if ((item?.type === 'function_call' || item?.type === 'custom_tool_call') && typeof item.name === 'string') {
            const index = typeof event.output_index === 'number' ? event.output_index : item.id ?? 0;
            state.toolNamesByIndex.set(index, item.name);
            state.toolArgumentLengthsByIndex.set(index, 0);
            if (typeof item.id === 'string') {
                state.toolNamesByIndex.set(item.id, item.name);
                state.toolArgumentLengthsByIndex.set(item.id, 0);
            }
        }
        if (item?.type === 'reasoning') {
            const id = typeof item.id === 'string' ? item.id : undefined;
            return { type: 'reasoning_started', ...(id !== undefined ? { id } : {}) };
        }
        if (item?.type === 'compaction') {
            state.compactionStartedAtByIndex.set(compactionIndex(event, item), Date.now());
            return { type: 'context_compaction_started', provider: 'openai' };
        }
        return null;
    }
    if (event.type === 'response.function_call_arguments.delta' ||
        event.type === 'response.custom_tool_call_input.delta' ||
        event.type === 'response.mcp_call_arguments.delta') {
        const index = typeof event.output_index === 'number' ? event.output_index : event.item_id ?? 0;
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta)
            return null;
        const argumentCharCount = (state.toolArgumentLengthsByIndex.get(index) ?? 0) + delta.length;
        state.toolArgumentLengthsByIndex.set(index, argumentCharCount);
        const toolName = state.toolNamesByIndex.get(index);
        return { type: 'tool_call_streaming_delta', ...(toolName ? { toolName } : {}), argumentCharCount };
    }
    // opencode may deliver the assembled arguments only on the done frames rather
    // than as incremental deltas. Surface the full count so the UI still shows the
    // "Calling <tool> (N chars)" indicator before tool_started replaces it.
    if (event.type === 'response.function_call_arguments.done' ||
        event.type === 'response.custom_tool_call_input.done' ||
        event.type === 'response.mcp_call_arguments.done') {
        const index = typeof event.output_index === 'number' ? event.output_index : event.item_id ?? 0;
        const fullArguments = typeof event.arguments === 'string' ? event.arguments : '';
        const previousLength = state.toolArgumentLengthsByIndex.get(index) ?? 0;
        const argumentCharCount = fullArguments.length || previousLength;
        if (argumentCharCount <= previousLength)
            return null;
        state.toolArgumentLengthsByIndex.set(index, argumentCharCount);
        const toolName = state.toolNamesByIndex.get(index);
        return { type: 'tool_call_streaming_delta', ...(toolName ? { toolName } : {}), argumentCharCount };
    }
    if (event.type === 'response.output_item.delta') {
        const delta = event.delta;
        const argumentsText = typeof delta?.arguments === 'string' ? delta.arguments : '';
        if (!argumentsText)
            return null;
        const index = typeof event.output_index === 'number' ? event.output_index : 0;
        const argumentCharCount = (state.toolArgumentLengthsByIndex.get(index) ?? 0) + argumentsText.length;
        state.toolArgumentLengthsByIndex.set(index, argumentCharCount);
        const toolName = state.toolNamesByIndex.get(index);
        return { type: 'tool_call_streaming_delta', ...(toolName ? { toolName } : {}), argumentCharCount };
    }
    if (event.type === 'response.output_item.done') {
        const item = event.item;
        if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
            const index = typeof event.output_index === 'number' ? event.output_index : item.id ?? item.call_id ?? 0;
            if (typeof item.name === 'string')
                state.toolNamesByIndex.set(index, item.name);
            const fullArguments = item.type === 'custom_tool_call'
                ? typeof item.input === 'string'
                    ? item.input
                    : ''
                : typeof item.arguments === 'string'
                    ? item.arguments
                    : '';
            const previousLength = Math.max(state.toolArgumentLengthsByIndex.get(index) ?? 0, typeof item.id === 'string' ? state.toolArgumentLengthsByIndex.get(item.id) ?? 0 : 0, typeof item.call_id === 'string' ? state.toolArgumentLengthsByIndex.get(item.call_id) ?? 0 : 0);
            if (fullArguments.length <= previousLength)
                return null;
            state.toolArgumentLengthsByIndex.set(index, fullArguments.length);
            return {
                type: 'tool_call_streaming_delta',
                ...(typeof item.name === 'string' ? { toolName: item.name } : {}),
                argumentCharCount: fullArguments.length,
            };
        }
        if (item?.type === 'compaction') {
            const key = compactionIndex(event, item);
            const startedAt = state.compactionStartedAtByIndex.get(key);
            state.compactionStartedAtByIndex.delete(key);
            // A `done` without a matching `added` would mean an unpaired frame; report 0 rather
            // than inventing an interval from an unrelated clock reading.
            return {
                type: 'context_compaction_completed',
                provider: lane,
                durationMs: startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
            };
        }
        return null;
    }
    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        const response = event.response ?? event;
        throw responseStatusError(event.type === 'response.failed' ? 'failed' : 'incomplete', {
            ...response,
            ...(event.error && !response.error ? { error: event.error } : {}),
        });
    }
    if (event.type === 'response.completed')
        return completedEvent(event.response ?? event, lane);
    return null;
}
export class OpenAIResponsesModelWithPromptCacheKey {
    lifecycle = new Lifecycle();
    _client;
    _model;
    capture;
    supportsContextCompaction;
    contextCompactionSessionState;
    /**
     * Which opaque lane this adapter's items belong to. Defaults to the OpenAI
     * lane; Grok speaks the same wire shape but is a different vendor, so its
     * encrypted reasoning must not cross into an OpenAI request.
     */
    lane;
    constructor(_client, _model, capture, supportsContextCompaction = false, contextCompactionSessionState, lane = OPENAI_RESPONSES_OPAQUE_TAG) {
        this._client = _client;
        this._model = _model.trim();
        this.capture = capture;
        this.supportsContextCompaction = supportsContextCompaction;
        this.contextCompactionSessionState = contextCompactionSessionState;
        this.lane = lane;
    }
    async getResponse(request) {
        this.lifecycle.begin(request, 'http', this._model, this._client);
        this.lifecycle.bind(request, this.capture);
        try {
            const response = await this._client.responses.create(requestBody(request, this._model, false, this.supportsContextCompaction, this.contextCompactionSessionState, this.lane), {
                ...(request.signal ? { signal: request.signal } : {}),
                ...(request.providerOptions?.extraHeaders
                    ? { headers: request.providerOptions.extraHeaders }
                    : {}),
            });
            assertUnaryResponseCompleted(response);
            const completion = completedEvent(response, this.lane);
            this.lifecycle.finish(request, 'terminal', this.capture, completion.responseId);
            return completion;
        }
        catch (error) {
            markContextCompactionFailure(error, request, this.contextCompactionSessionState);
            this.lifecycle.finish(request, 'failed', this.capture);
            throw error;
        }
    }
    async *stream(request) {
        yield* this.#streamHttp(request);
    }
    async *#streamHttp(request) {
        this.lifecycle.begin(request, 'http', this._model, this._client);
        this.lifecycle.bind(request, this.capture);
        let terminal = false;
        try {
            const source = await this._client.responses.create(requestBody(request, this._model, true, this.supportsContextCompaction, this.contextCompactionSessionState, this.lane), {
                ...(request.signal ? { signal: request.signal } : {}),
                ...(request.providerOptions?.extraHeaders
                    ? { headers: request.providerOptions.extraHeaders }
                    : {}),
            });
            const normalizationState = createResponseEventNormalizationState();
            for await (const event of source) {
                const normalized = normalizeResponseEvent(event, normalizationState, this.lane);
                if (normalized?.type === 'completion') {
                    terminal = true;
                    this.lifecycle.finish(request, 'terminal', this.capture, normalized.responseId);
                }
                if (normalized)
                    yield normalized;
            }
            if (!terminal)
                throw new Error('OpenAI streamed response ended without a completion.');
        }
        catch (error) {
            markContextCompactionFailure(error, request, this.contextCompactionSessionState);
            if (!terminal)
                this.lifecycle.finish(request, 'failed', this.capture);
            throw error;
        }
        finally {
            if (!terminal)
                this.lifecycle.finish(request, 'abandoned', this.capture);
        }
    }
}
export class OpenAIResponsesWSModelWithPromptCacheKey extends OpenAIResponsesModelWithPromptCacheKey {
    #sessions = new ResponsesWebSocketSessions((headers) => new ResponsesWS(this._client, headers ? { headers } : undefined));
    async close() {
        this.#sessions.close();
    }
    async *stream(request) {
        this.lifecycle.begin(request, 'websocket', this._model, this._client);
        this.lifecycle.bind(request, this.capture);
        const headers = request.providerOptions?.extraHeaders;
        const socket = this.#sessions.acquire(headers);
        let terminal = false;
        let iteratorFinished = false;
        let iterator;
        let released = false;
        const release = (keepAlive) => {
            if (released)
                return;
            released = true;
            this.#sessions.release(socket, { keepAlive });
        };
        try {
            socket.send({
                type: 'response.create',
                ...requestBody(request, this._model, true, this.supportsContextCompaction, this.contextCompactionSessionState, this.lane),
            });
            const normalizationState = createResponseEventNormalizationState();
            iterator = socket.stream()[Symbol.asyncIterator]();
            while (true) {
                // The socket iterator's pending `next()` only settles when the socket
                // itself emits something; nothing else bound `request.signal` to it,
                // so cancelling mid-turn left this loop (and cancel_run) suspended
                // forever. Race the wait against the signal instead.
                const next = await raceWebSocketAbort(iterator.next(), request.signal);
                if (next.done) {
                    iteratorFinished = true;
                    break;
                }
                const message = next.value;
                if (message.type === 'error')
                    throw message.error ?? new Error('OpenAI WebSocket provider error');
                // This model never records a dispatch state, so a close is only ever
                // ambiguous here: capture the code, but never claim it was unsent.
                if (message.type === 'close')
                    throw new WebSocketClosedEarlyError(readWebSocketCloseFrame(message));
                if (message.type !== 'message')
                    continue;
                const normalized = normalizeResponseEvent(message.message, normalizationState, this.lane);
                if (normalized?.type === 'completion') {
                    terminal = true;
                    this.lifecycle.finish(request, 'terminal', this.capture, normalized.responseId);
                }
                if (normalized)
                    yield normalized;
                if (terminal)
                    return;
            }
            // The iterator ended with no close frame, so there is no close code to
            // read: an unexplained end is treated the same as an unexplained close.
            if (!terminal)
                throw new WebSocketClosedEarlyError({});
        }
        catch (error) {
            release(false);
            markContextCompactionFailure(error, request, this.contextCompactionSessionState);
            if (!terminal)
                this.lifecycle.finish(request, 'failed', this.capture);
            throw error;
        }
        finally {
            if (iterator && !iteratorFinished) {
                // Neither branch awaits the SDK iterator's return: a terminal event
                // ends one response, not the session-scoped socket, and a cancelled
                // or errored wait must not trade one hang (the unsettled `next()`)
                // for another (a `return()` that itself waits on socket closure).
                // Settlement above (terminal/error/abort) is authoritative either way.
                try {
                    void iterator.return?.().catch(() => undefined);
                }
                catch {
                    // Settlement above remains authoritative.
                }
            }
            if (terminal) {
                release(true);
            }
            else {
                release(false);
                this.lifecycle.finish(request, 'abandoned', this.capture);
            }
        }
    }
}
//# sourceMappingURL=openai-responses-model.js.map