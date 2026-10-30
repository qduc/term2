import { toolOccurrenceMetadata } from './tool-occurrence.js';
const clone = (value) => {
    try {
        return structuredClone(value);
    }
    catch {
        return JSON.parse(JSON.stringify(value));
    }
};
const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const rawItem = (value) => {
    const record = asRecord(value);
    return record ? asRecord(record.rawItem) ?? record : null;
};
const getString = (value) => (typeof value === 'string' && value ? value : undefined);
const cloneRecord = (value) => {
    const record = asRecord(value);
    return record ? clone(record) : undefined;
};
const extractTextParts = (content) => {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((part) => {
        const record = asRecord(part);
        const type = getString(record?.type);
        return (type === 'output_text' || type === 'text') && typeof record?.text === 'string';
    })
        .map((part) => String(part.text))
        .join('');
};
const extractReasoningParts = (content) => {
    if (!Array.isArray(content))
        return '';
    return content
        .filter((part) => {
        const record = asRecord(part);
        const type = getString(record?.type);
        return (type === 'reasoning_text' || type === 'reasoning') && typeof record?.text === 'string';
    })
        .map((part) => String(part.text))
        .join('');
};
const getProviderMetadata = (item) => {
    const raw = rawItem(item);
    const providerData = cloneRecord(raw?.providerData) ?? cloneRecord(raw?.provider_data) ?? cloneRecord(asRecord(item)?.providerData);
    const reasoning = getString(raw?.reasoning) ?? getString(asRecord(item)?.reasoning);
    const reasoningContent = getString(raw?.reasoning_content) ??
        getString(asRecord(item)?.reasoning_content) ??
        getString(providerData?.reasoning_content);
    const reasoningDetails = raw?.reasoning_details ?? asRecord(item)?.reasoning_details ?? providerData?.reasoning_details;
    const metadata = providerData ? clone(providerData) : {};
    if (reasoning)
        metadata.reasoning = reasoning;
    if (reasoningContent)
        metadata.reasoning_content = reasoningContent;
    if (reasoningDetails != null)
        metadata.reasoning_details = clone(reasoningDetails);
    return Object.keys(metadata).length > 0 ? metadata : undefined;
};
const getReasoningText = (item) => {
    const raw = rawItem(item);
    if (!raw)
        return '';
    const direct = getString(raw.text) ??
        getString(raw.delta) ??
        getString(raw.summary) ??
        getString(raw.reasoning_content) ??
        getString(asRecord(item)?.reasoning_content);
    if (direct)
        return direct;
    const fromMetadata = getString(getProviderMetadata(item)?.reasoning_content);
    if (fromMetadata)
        return fromMetadata;
    return (extractReasoningParts(raw.rawContent) ||
        extractReasoningParts(asRecord(item)?.rawContent) ||
        extractReasoningParts(raw.content) ||
        extractTextParts(raw.content));
};
const getProviderItemId = (item) => {
    const raw = rawItem(item);
    return getString(raw?.id) ?? getString(asRecord(item)?.id);
};
const makeReasoningItem = (item) => {
    const text = getReasoningText(item);
    const providerMetadata = getProviderMetadata(item);
    const providerItemId = getProviderItemId(item);
    const raw = rawItem(item);
    const sequence = typeof raw?.index === 'number' ? raw.index : undefined;
    if (!text && !providerMetadata)
        return null;
    return {
        type: 'reasoning',
        text,
        ...(providerMetadata ? { providerMetadata } : {}),
        ...(providerItemId ? { providerItemId } : {}),
        ...(sequence !== undefined ? { sequence } : {}),
    };
};
const pushAssistantMessageItems = (target, item) => {
    const text = extractTextParts(rawItem(item)?.content);
    const providerMetadata = getProviderMetadata(item);
    const providerItemId = getProviderItemId(item);
    const reasoningText = getString(providerMetadata?.reasoning_content);
    if (reasoningText)
        target.push({ type: 'reasoning', text: reasoningText, ...(providerMetadata ? { providerMetadata } : {}) });
    if (!text)
        return;
    const assistantTextItem = {
        type: 'assistant_text',
        text,
        ...(providerMetadata ? { providerMetadata } : {}),
        ...(providerItemId ? { providerItemId } : {}),
    };
    target.push(assistantTextItem);
};
const getCallId = (raw, item) => {
    const outer = asRecord(item);
    return (getString(outer?.callId) ??
        getString(outer?.call_id) ??
        getString(outer?.tool_call_id) ??
        getString(outer?.toolCallId) ??
        getString(outer?.id) ??
        getString(raw.callId) ??
        getString(raw.call_id) ??
        getString(raw.tool_call_id) ??
        getString(raw.toolCallId) ??
        getString(raw.id) ??
        'unknown-call');
};
const toolResultItemTypes = new Set([
    'function_call_result',
    'function_call_output',
    'function_call_output_result',
    'tool_call_output_item',
    'tool_result',
    'shell_call_output',
    'tool_call_output',
    'tool_call_result',
    'local_shell_call_output',
    'computer_call_output',
    'computer_call_result',
    'apply_patch_call_output',
]);
const pushChatToolCallItems = (target, item) => {
    const raw = rawItem(item);
    if (!raw || !Array.isArray(raw.tool_calls))
        return;
    for (const candidate of raw.tool_calls) {
        const call = asRecord(candidate);
        if (!call)
            continue;
        const functionRecord = asRecord(call.function);
        const callId = getString(call.id) ?? getString(call.callId) ?? getString(call.call_id) ?? getString(call.tool_call_id);
        if (!callId)
            continue;
        target.push({
            type: 'tool_call',
            callId,
            toolName: getString(functionRecord?.name) ?? getString(call.name) ?? 'unknown',
            arguments: functionRecord?.arguments ?? call.arguments ?? call.args,
            providerItem: clone(call),
        });
    }
};
const pushToolCallItem = (target, item) => {
    const raw = rawItem(item);
    if (!raw)
        return;
    const providerMetadata = getProviderMetadata(item);
    const reasoningText = getString(providerMetadata?.reasoning_content);
    if (reasoningText)
        target.push({ type: 'reasoning', text: reasoningText, ...(providerMetadata ? { providerMetadata } : {}) });
    const toolCallItem = {
        type: 'tool_call',
        callId: getCallId(raw, item),
        ...toolOccurrenceMetadata({ ...raw, ...asRecord(item) }),
        toolName: getString(raw.name) ?? getString(asRecord(item)?.name) ?? 'unknown',
        arguments: raw.arguments ??
            raw.args ??
            raw.operation ??
            asRecord(item)?.arguments ??
            asRecord(item)?.args ??
            asRecord(item)?.operation,
        providerItem: clone(raw),
    };
    target.push(toolCallItem);
};
const pushToolResultItem = (target, item) => {
    const raw = rawItem(item);
    if (!raw)
        return;
    const outer = asRecord(item);
    const providerItem = {
        ...raw,
        ...(getString(raw.id) || !getString(outer?.id) ? {} : { id: outer?.id }),
    };
    const toolResultItem = {
        type: 'tool_result',
        callId: getCallId(raw, item),
        ...toolOccurrenceMetadata({ ...raw, ...asRecord(item) }),
        toolName: getString(raw.name) ??
            getString(asRecord(item)?.name) ??
            (raw.type === 'apply_patch_call_output' ? 'apply_patch' : 'unknown'),
        status: typeof raw.is_error === 'boolean' && raw.is_error ? 'failed' : 'completed',
        output: raw.output ?? asRecord(item)?.output,
        providerItem: clone(providerItem),
        ...(raw.runCodeExecution ?? outer?.runCodeExecution
            ? { runCodeExecution: (raw.runCodeExecution ?? outer?.runCodeExecution) }
            : {}),
    };
    target.push(toolResultItem);
};
const isCanonicalItem = (item) => {
    const record = asRecord(item);
    return (((record?.type === 'assistant_text' || record?.type === 'reasoning') && typeof record.text === 'string') ||
        (record?.type === 'tool_call' && typeof record.callId === 'string' && typeof record.toolName === 'string') ||
        (record?.type === 'tool_result' && typeof record.callId === 'string' && typeof record.toolName === 'string'));
};
/**
 * Recognizes both the raw `StreamedModelTurnOutput` `provider_opaque` shape
 * (`{ type: 'provider_opaque', provider, item }`, produced by e.g.
 * `openai-responses-model.ts`'s `toTurnOutput`) and the identically-shaped
 * already-persisted `ProviderOpaqueItem`, so re-normalizing an already
 * canonical opaque item is idempotent. The payload is stored and cloned
 * verbatim — no per-provider-item-variant schema.
 */
const asProviderOpaqueItem = (value) => {
    const record = asRecord(value);
    if (!record || record.type !== 'provider_opaque')
        return null;
    const provider = getString(record.provider);
    const sourceProvider = getString(record.sourceProvider);
    const payload = asRecord(record.item);
    if (!provider || !payload)
        return null;
    return {
        type: 'provider_opaque',
        provider,
        ...(sourceProvider ? { sourceProvider } : {}),
        item: clone(payload),
    };
};
/** Converts raw provider run items to serializable domain items at the conversation boundary. */
export function normalizeRunItem(item) {
    if (isCanonicalItem(item))
        return [item];
    const providerOpaque = asProviderOpaqueItem(item);
    if (providerOpaque)
        return [providerOpaque];
    const raw = rawItem(item);
    if (!raw)
        return [];
    if (isCanonicalItem(raw))
        return [raw];
    const outer = asRecord(item);
    const role = getString(raw.role) ?? getString(outer?.role);
    const type = getString(raw.type) ?? getString(outer?.type) ?? '';
    if (type === 'reasoning') {
        const reasoning = makeReasoningItem(item);
        return reasoning ? [reasoning] : [];
    }
    const normalized = [];
    if (role === 'assistant' && type === 'message') {
        pushAssistantMessageItems(normalized, item);
        pushChatToolCallItems(normalized, item);
    }
    else if (type === 'function_call' || type === 'apply_patch_call')
        pushToolCallItem(normalized, item);
    else if (toolResultItemTypes.has(type))
        pushToolResultItem(normalized, item);
    return normalized;
}
export function normalizeRunItems(items) {
    if (!Array.isArray(items))
        return [];
    return items.flatMap(normalizeRunItem);
}
//# sourceMappingURL=run-item-normalizer.js.map