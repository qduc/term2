import { wrapLanguageModel } from 'ai';
function hasContent(content) {
    return content !== null && content !== undefined && content !== '';
}
function hasReasoningPayload(message) {
    if (message.role !== 'assistant') {
        return false;
    }
    const candidates = [
        message,
        ...(typeof message.providerData === 'object' && message.providerData !== null
            ? [message.providerData]
            : []),
        ...(typeof message.provider_data === 'object' && message.provider_data !== null
            ? [message.provider_data]
            : []),
    ];
    return candidates.some((candidate) => typeof candidate.reasoning === 'string' ||
        typeof candidate.reasoning_content === 'string' ||
        (Array.isArray(candidate.reasoning_details) && candidate.reasoning_details.length > 0));
}
function hasAssistantPayload(message) {
    if (message.role !== 'assistant') {
        return true;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return true;
    }
    if (hasReasoningPayload(message)) {
        return true;
    }
    if (!Array.isArray(message.content)) {
        return hasContent(message.content);
    }
    return message.content.length > 0;
}
function contentToParts(content) {
    if (!hasContent(content)) {
        return [];
    }
    if (Array.isArray(content)) {
        return content;
    }
    return [{ type: 'text', text: String(content) }];
}
function mergeAssistantContent(existing, incoming) {
    if (!hasContent(existing)) {
        return incoming;
    }
    if (!hasContent(incoming)) {
        return existing;
    }
    if (typeof existing === 'string' && typeof incoming === 'string') {
        return `${existing}\n${incoming}`;
    }
    return [...contentToParts(existing), ...contentToParts(incoming)];
}
function appendStringField(message, field, value) {
    if (typeof value !== 'string') {
        return;
    }
    message[field] = typeof message[field] === 'string' ? `${message[field]}${value}` : value;
}
function appendArrayLikeField(message, field, value) {
    if (value == null) {
        return;
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) {
        return;
    }
    const existingArray = Array.isArray(message[field]) ? message[field] : [];
    message[field] = [...existingArray, ...values];
}
function mergeAssistantMessagePair(existing, incoming) {
    const merged = {
        ...existing,
        ...incoming,
        role: 'assistant',
        content: mergeAssistantContent(existing.content, incoming.content),
        tool_calls: undefined,
        reasoning: undefined,
        reasoning_content: undefined,
        reasoning_details: undefined,
    };
    appendArrayLikeField(merged, 'tool_calls', existing.tool_calls);
    appendArrayLikeField(merged, 'tool_calls', incoming.tool_calls);
    appendStringField(merged, 'reasoning', existing.reasoning);
    appendStringField(merged, 'reasoning', incoming.reasoning);
    appendStringField(merged, 'reasoning_content', existing.reasoning_content);
    appendStringField(merged, 'reasoning_content', incoming.reasoning_content);
    appendArrayLikeField(merged, 'reasoning_details', existing.reasoning_details);
    appendArrayLikeField(merged, 'reasoning_details', incoming.reasoning_details);
    for (const field of ['tool_calls', 'reasoning', 'reasoning_content', 'reasoning_details']) {
        if (merged[field] === undefined) {
            delete merged[field];
        }
    }
    if (merged.content === undefined) {
        delete merged.content;
    }
    return merged;
}
export function mergeAssistantMessages(messages) {
    const merged = [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            merged.push(message);
            continue;
        }
        const previous = merged[merged.length - 1];
        if (previous?.role === 'assistant' && message.role === 'assistant') {
            merged[merged.length - 1] = mergeAssistantMessagePair(previous, message);
            continue;
        }
        merged.push(message);
    }
    return merged.filter((msg) => hasAssistantPayload(msg));
}
function normalizeMessageOptions(options) {
    const opts = options;
    if (!Array.isArray(opts.prompt) && !Array.isArray(opts.messages)) {
        return options;
    }
    return {
        ...options,
        ...(Array.isArray(opts.prompt) ? { prompt: mergeAssistantMessages(opts.prompt) } : {}),
        ...(Array.isArray(opts.messages)
            ? { messages: mergeAssistantMessages(opts.messages) }
            : {}),
    };
}
const mergeAssistantMessagesMiddleware = {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => normalizeMessageOptions(params),
};
export function withMergedAssistantMessages(model) {
    return wrapLanguageModel({
        model,
        middleware: mergeAssistantMessagesMiddleware,
    });
}
//# sourceMappingURL=ai-sdk-message-normalizer.js.map