import { withMergedAssistantMessages } from './ai-sdk-message-normalizer.js';
const MAX_TRIVIAL_WHITESPACE_LENGTH = 4;
function isTrivialWhitespace(text) {
    return text.length > 0 && text.length <= MAX_TRIVIAL_WHITESPACE_LENGTH && text.trim() === '';
}
/** Adapts one AI SDK LanguageModelV3 stream to the application-owned turn protocol. */
export function createAiSdkStreamedModel(model, resolveProviderOptions = (request) => request.providerOptions) {
    const normalizedModel = withMergedAssistantMessages(model);
    return {
        async getResponse(request) {
            const result = (await normalizedModel.doGenerate(toCallOptions(request, resolveProviderOptions(request))));
            const output = [];
            if (typeof result.reasoning === 'string' && result.reasoning) {
                output.push({ type: 'reasoning', text: result.reasoning });
            }
            if (typeof result.text === 'string' && result.text) {
                output.push({ type: 'message', content: [{ type: 'text', text: result.text }] });
            }
            for (const call of result.toolCalls ?? []) {
                output.push({ type: 'tool_call', id: call.toolCallId, name: call.toolName, arguments: call.input ?? '{}' });
            }
            const usage = result.usage ?? {};
            const costUsd = extractAiSdkCostUsd(result.providerMetadata, usage);
            return {
                responseId: result.response?.id ?? `response-${Date.now()}`,
                output,
                usage: {
                    ...(usage.inputTokens?.total !== undefined ? { inputTokens: usage.inputTokens.total } : {}),
                    ...(usage.outputTokens?.total !== undefined ? { outputTokens: usage.outputTokens.total } : {}),
                    ...(usage.inputTokens?.cacheRead !== undefined ? { cachedInputTokens: usage.inputTokens.cacheRead } : {}),
                    ...(usage.inputTokens?.cacheWrite !== undefined ? { cacheWriteTokens: usage.inputTokens.cacheWrite } : {}),
                    ...(usage.outputTokens?.reasoning !== undefined ? { reasoningTokens: usage.outputTokens.reasoning } : {}),
                },
                ...(costUsd !== undefined ? { costUsd } : {}),
                ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
            };
        },
        async *stream(request) {
            const result = await normalizedModel.doStream(toCallOptions(request, resolveProviderOptions(request)));
            let responseId;
            let completionMetadata;
            const output = [];
            const reasoning = new Map();
            const toolCalls = new Map();
            let pendingTrivialWhitespace = '';
            let pendingTrivialWhitespacePartId;
            let lastTextPartId;
            let hasMaterialOutput = false;
            const textDelta = (text, partId) => {
                if (text) {
                    appendText(output, text, partId !== undefined && lastTextPartId !== undefined && partId !== lastTextPartId);
                    if (partId !== undefined)
                        lastTextPartId = partId;
                }
                return { type: 'text_delta', ...(partId !== undefined ? { partId } : {}), text };
            };
            // Providers can emit a one-character placeholder immediately before an
            // in-band error. Keep only a bounded leading prefix uncommitted so the
            // RetryingModel's any-yield-is-committed invariant remains unchanged.
            const flushPendingWhitespace = () => {
                if (!pendingTrivialWhitespace)
                    return undefined;
                const text = pendingTrivialWhitespace;
                pendingTrivialWhitespace = '';
                hasMaterialOutput = true;
                return textDelta(text, pendingTrivialWhitespacePartId);
            };
            for await (const part of result.stream) {
                if (part.type === 'response-metadata') {
                    if (part.id !== undefined)
                        responseId = part.id;
                    continue;
                }
                if (part.type === 'text-delta') {
                    // Empty text frames are not material. In particular, do not let one
                    // between a placeholder and an error force the placeholder out.
                    if (!part.delta && pendingTrivialWhitespace)
                        continue;
                    if (!hasMaterialOutput &&
                        isTrivialWhitespace(part.delta) &&
                        pendingTrivialWhitespace.length + part.delta.length <= MAX_TRIVIAL_WHITESPACE_LENGTH) {
                        pendingTrivialWhitespace += part.delta;
                        pendingTrivialWhitespacePartId = part.id;
                        continue;
                    }
                    const flushedWhitespace = flushPendingWhitespace();
                    if (flushedWhitespace)
                        yield flushedWhitespace;
                    if (part.delta)
                        hasMaterialOutput = true;
                    yield textDelta(part.delta, part.id);
                    continue;
                }
                if (part.type === 'reasoning-start') {
                    const current = { text: '', ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}) };
                    reasoning.set(part.id, current);
                    output.push({
                        type: 'reasoning',
                        id: part.id,
                        text: current.text,
                        ...(current.providerMetadata ? { providerMetadata: current.providerMetadata } : {}),
                    });
                    yield {
                        type: 'reasoning_started',
                        ...(part.id ? { id: part.id } : {}),
                    };
                    continue;
                }
                if (part.type === 'reasoning-delta') {
                    const flushedWhitespace = flushPendingWhitespace();
                    if (flushedWhitespace)
                        yield flushedWhitespace;
                    const current = reasoning.get(part.id) ?? { text: '' };
                    current.text += part.delta;
                    if (part.providerMetadata)
                        current.providerMetadata = part.providerMetadata;
                    reasoning.set(part.id, current);
                    const outputReasoning = output.find((item) => item.type === 'reasoning' && item.id === part.id);
                    if (outputReasoning?.type === 'reasoning') {
                        outputReasoning.text = current.text;
                        if (current.providerMetadata)
                            outputReasoning.providerMetadata =
                                current.providerMetadata;
                    }
                    yield {
                        type: 'reasoning_delta',
                        id: part.id,
                        text: part.delta,
                        ...(current.providerMetadata ? { providerMetadata: current.providerMetadata } : {}),
                    };
                    hasMaterialOutput = true;
                    continue;
                }
                if (part.type === 'reasoning-end') {
                    const current = reasoning.get(part.id);
                    if (current && part.providerMetadata) {
                        current.providerMetadata = part.providerMetadata;
                        const outputIndex = output.findIndex((item) => item.type === 'reasoning' && item.id === part.id);
                        const outputReasoning = output.at(outputIndex);
                        if (outputReasoning?.type === 'reasoning')
                            output[outputIndex] = { ...outputReasoning, providerMetadata: part.providerMetadata };
                    }
                    continue;
                }
                if (part.type === 'tool-input-start') {
                    toolCalls.set(part.id, { name: part.toolName, argumentCharCount: 0 });
                    continue;
                }
                if (part.type === 'tool-input-delta') {
                    const flushedWhitespace = flushPendingWhitespace();
                    if (flushedWhitespace)
                        yield flushedWhitespace;
                    const current = toolCalls.get(part.id) ?? { name: '', argumentCharCount: 0 };
                    current.argumentCharCount += part.delta.length;
                    toolCalls.set(part.id, current);
                    yield {
                        type: 'tool_call_streaming_delta',
                        ...(current.name ? { toolName: current.name } : {}),
                        argumentCharCount: current.argumentCharCount,
                    };
                    hasMaterialOutput = true;
                    continue;
                }
                if (part.type === 'tool-input-end' ||
                    part.type === 'text-start' ||
                    part.type === 'text-end' ||
                    part.type === 'stream-start' ||
                    part.type === 'raw' ||
                    part.type === 'file' ||
                    part.type === 'source' ||
                    part.type === 'tool-result' ||
                    part.type === 'tool-approval-request') {
                    continue;
                }
                if (part.type === 'tool-call') {
                    const flushedWhitespace = flushPendingWhitespace();
                    if (flushedWhitespace)
                        yield flushedWhitespace;
                    yield* publishToolCall(output, part.toolCallId, {
                        name: part.toolName,
                        arguments: part.input,
                        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
                    });
                    hasMaterialOutput = true;
                    continue;
                }
                if (part.type === 'finish') {
                    if (part.finishReason.unified === 'other' && part.finishReason.raw == null) {
                        throw new Error('AI SDK streamed response ended without an authoritative native finish reason');
                    }
                    completionMetadata = part.providerMetadata;
                    const id = responseId;
                    if (!id)
                        throw new Error('AI SDK streamed response did not include a response id');
                    const flushedWhitespace = flushPendingWhitespace();
                    if (flushedWhitespace)
                        yield flushedWhitespace;
                    appendUnendedReasoning(output, reasoning);
                    const costUsd = extractAiSdkCostUsd(part.providerMetadata, part.usage);
                    yield {
                        type: 'completion',
                        responseId: id,
                        output,
                        finishReason: part.finishReason.unified,
                        usage: {
                            ...(part.usage.inputTokens.total !== undefined ? { inputTokens: part.usage.inputTokens.total } : {}),
                            ...(part.usage.outputTokens.total !== undefined ? { outputTokens: part.usage.outputTokens.total } : {}),
                            ...(part.usage.inputTokens.cacheRead !== undefined
                                ? { cachedInputTokens: part.usage.inputTokens.cacheRead }
                                : {}),
                            ...(part.usage.inputTokens.cacheWrite !== undefined
                                ? { cacheWriteTokens: part.usage.inputTokens.cacheWrite }
                                : {}),
                            ...(part.usage.outputTokens.reasoning !== undefined
                                ? { reasoningTokens: part.usage.outputTokens.reasoning }
                                : {}),
                        },
                        ...(costUsd !== undefined ? { costUsd } : {}),
                        providerMetadata: { ...completionMetadata, model: `${model.provider}:${model.modelId}`, responseId: id },
                    };
                    return;
                }
                if (part.type === 'error') {
                    pendingTrivialWhitespace = '';
                    throw part.error;
                }
            }
            pendingTrivialWhitespace = '';
            throw new Error('AI SDK streamed response ended without a finish event');
        },
    };
}
function toCallOptions(request, providerOptions) {
    const toolNames = new Map(request.input.filter((item) => item.type === 'tool_call').map((item) => [item.id, item.name]));
    const instructions = request.instructions
        ? [{ role: 'system', content: request.instructions }]
        : [];
    return {
        prompt: [
            ...instructions,
            // The AI SDK lane never produces opaque items, so any it sees came from
            // another provider and is inert baggage left by a switch, not a fault.
            // See `provider-opaque-compatibility.ts`.
            ...request.input
                .filter((item) => item.type !== 'provider_opaque')
                .map((item) => toPromptMessage(item, toolNames)),
        ],
        ...(request.tools.length ? { tools: request.tools.map(toTool) } : {}),
        ...(request.toolChoice ? { toolChoice: toToolChoice(request.toolChoice) } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { topP: request.topP } : {}),
        ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
        ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
        ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
        ...(request.outputType && request.outputType !== 'text'
            ? {
                responseFormat: {
                    type: 'json',
                    name: request.outputType.name,
                    schema: request.outputType.schema,
                },
            }
            : {}),
        ...(providerOptions ? { providerOptions } : {}),
        ...(request.signal ? { abortSignal: request.signal } : {}),
    };
}
function toPromptMessage(item, toolNames) {
    if (item.type === 'message') {
        if (item.role === 'system')
            return { role: 'system', content: item.content.map((part) => part.text).join('') };
        return { role: item.role, content: item.content.map(toMessagePart) };
    }
    if (item.type === 'reasoning')
        return {
            role: 'assistant',
            content: [
                {
                    type: 'reasoning',
                    text: item.text,
                    ...(item.providerMetadata ? { providerOptions: item.providerMetadata } : {}),
                },
            ],
        };
    if (item.type === 'tool_call')
        return {
            role: 'assistant',
            content: [
                {
                    type: 'tool-call',
                    toolCallId: item.id,
                    toolName: item.name,
                    input: parseJson(item.arguments),
                    ...(item.providerMetadata ? { providerOptions: item.providerMetadata } : {}),
                },
            ],
        };
    if (item.type === 'provider_opaque')
        // Filtered out in `toCallOptions`; reaching here means a new caller bypassed
        // that filter, which would put a foreign payload on the wire.
        throw new Error(`Refusing to serialize provider_opaque from '${item.provider}' through the AI SDK: opaque items are only valid on the provider that produced them`);
    const toolName = toolNames.get(item.id);
    if (!toolName)
        throw new Error(`AI SDK tool result has no matching tool call: ${item.id}`);
    return {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: item.id, toolName, output: toToolResult(item.output) }],
    };
}
function toMessagePart(part) {
    if (part.type === 'text')
        return part;
    if (!part.image)
        throw new Error('AI SDK image message part requires an image');
    const data = typeof part.image === 'object' ? part.image.id : part.image;
    return {
        type: 'file',
        data,
        mediaType: mediaType(data),
        ...(part.detail ? { providerOptions: { detail: { detail: part.detail } } } : {}),
    };
}
function toToolResult(output) {
    if (typeof output === 'string')
        return { type: 'text', value: output };
    return { type: 'content', value: output.map(toToolResultPart) };
}
function toToolResultPart(part) {
    if (part.type === 'text')
        return part;
    const value = part.type === 'image' ? part.image : part.file;
    if (!value)
        throw new Error('AI SDK tool result part requires file or image data');
    if (typeof value === 'string')
        return part.type === 'image' ? { type: 'image-url', url: value } : { type: 'file-url', url: value };
    if ('data' in value)
        return {
            type: part.type === 'image' ? 'image-data' : 'file-data',
            data: typeof value.data === 'string' ? value.data : Buffer.from(value.data).toString('base64'),
            mediaType: value.mediaType ?? 'application/octet-stream',
        };
    if ('url' in value)
        return part.type === 'image' ? { type: 'image-url', url: value.url } : { type: 'file-url', url: value.url };
    return {
        type: part.type === 'image' ? 'image-file-id' : 'file-id',
        fileId: 'fileId' in value ? value.fileId : value.id,
    };
}
function toTool(tool) {
    if (tool.type === 'custom') {
        throw new Error(`AI SDK transport does not support custom tool '${tool.name}'.`);
    }
    return {
        type: 'function',
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.parameters,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    };
}
function toToolChoice(choice) {
    return typeof choice === 'object' ? { type: 'tool', toolName: choice.name } : { type: choice };
}
function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function mediaType(value) {
    return value.match(/^data:([^;,]+)/)?.[1] ?? 'image/*';
}
function appendText(output, text, startsNewPart) {
    const last = output.at(-1);
    if (last?.type === 'message' && !startsNewPart) {
        const part = last.content.at(-1);
        if (part)
            part.text += text;
        return;
    }
    output.push({ type: 'message', content: [{ type: 'text', text }] });
}
function appendUnendedReasoning(output, reasoning) {
    for (const [id, current] of reasoning) {
        if (output.some((item) => item.type === 'reasoning' && item.id === id))
            continue;
        output.push({
            type: 'reasoning',
            id,
            text: current.text,
            ...(current.providerMetadata ? { providerMetadata: current.providerMetadata } : {}),
        });
    }
}
function* publishToolCall(output, id, call) {
    const event = { type: 'tool_call', id, ...call };
    output.push(event);
    yield event;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function parseCostValue(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim().length > 0)
        return value;
    return undefined;
}
/**
 * Extract provider-reported cost (USD amount or credits) from AI SDK
 * provider metadata or usage when present (e.g. OpenRouter usage accounting).
 */
function extractAiSdkCostUsd(providerMetadata, usage) {
    const usageRecord = asRecord(usage);
    if (usageRecord) {
        const rawRecord = asRecord(usageRecord.raw);
        const rawCost = parseCostValue(rawRecord?.cost ?? usageRecord.cost);
        if (rawCost !== undefined)
            return rawCost;
    }
    if (!providerMetadata || typeof providerMetadata !== 'object')
        return undefined;
    for (const [key, value] of Object.entries(providerMetadata)) {
        if (key === 'model' || key === 'responseId')
            continue;
        const record = asRecord(value);
        if (record) {
            const nestedUsage = asRecord(record.usage);
            const costDetails = asRecord(nestedUsage?.costDetails) ?? asRecord(nestedUsage?.cost_details);
            const nestedCost = parseCostValue(nestedUsage?.cost ?? record.cost ?? costDetails?.upstreamInferenceCost ?? costDetails?.upstream_inference_cost);
            if (nestedCost !== undefined)
                return nestedCost;
        }
    }
    return undefined;
}
/**
 * Extract provider-reported upstream provider name (e.g. OpenRouter upstream routing)
 * from AI SDK provider metadata when present.
 */
export function extractAiSdkUpstreamProvider(providerMetadata) {
    if (!providerMetadata || typeof providerMetadata !== 'object')
        return undefined;
    if (typeof providerMetadata.provider === 'string' && providerMetadata.provider.trim().length > 0) {
        return providerMetadata.provider.trim();
    }
    if (typeof providerMetadata.provider_name === 'string' && providerMetadata.provider_name.trim().length > 0) {
        return providerMetadata.provider_name.trim();
    }
    for (const [key, value] of Object.entries(providerMetadata)) {
        if (key === 'model' || key === 'responseId')
            continue;
        const record = asRecord(value);
        if (record) {
            if (typeof record.provider === 'string' && record.provider.trim().length > 0) {
                return record.provider.trim();
            }
            if (typeof record.provider_name === 'string' && record.provider_name.trim().length > 0) {
                return record.provider_name.trim();
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=ai-sdk-streamed-model.js.map