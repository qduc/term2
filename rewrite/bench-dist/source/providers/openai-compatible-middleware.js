import { mergeAssistantMessages } from './ai-sdk-message-normalizer.js';
function sanitizeOpenAICompatibleMessages(messages) {
    return messages.map((message) => {
        if (!message || typeof message !== 'object')
            return message;
        const { index: _strayIndex, ...message_ } = message;
        message = message_;
        let newContent = message.content;
        if (Array.isArray(message.content)) {
            newContent = message.content.map((part) => {
                if (!part || typeof part !== 'object')
                    return part;
                const { annotations: _, ...rest } = part;
                return rest;
            });
        }
        return {
            ...message,
            content: newContent,
        };
    });
}
function hasReasoningPayload(message) {
    const candidates = [message, message?.providerData, message?.provider_data].filter(Boolean);
    return candidates.some((candidate) => typeof candidate.reasoning === 'string' ||
        typeof candidate.reasoning_content === 'string' ||
        (Array.isArray(candidate.reasoning_details) && candidate.reasoning_details.length > 0));
}
export function sanitizeResponsesApiBody(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.input)) {
        return body;
    }
    const sanitizedInput = body.input.filter((item) => {
        const rawItem = item?.rawItem ?? item;
        if (!rawItem || typeof rawItem !== 'object') {
            return true;
        }
        const isMessage = rawItem.type === 'message' || (rawItem.role && rawItem.content !== undefined);
        if (!isMessage) {
            return true;
        }
        if (hasReasoningPayload(rawItem)) {
            return true;
        }
        return !Array.isArray(rawItem.content) || rawItem.content.length > 0;
    });
    if (sanitizedInput.length === body.input.length) {
        return body;
    }
    return {
        ...body,
        input: sanitizedInput,
    };
}
/** Normalize Chat Completions messages without applying vendor policy. */
export function createOpenAICompatibleMiddleware() {
    return async (ctx, next) => {
        if (typeof ctx.init?.body !== 'string')
            return next(ctx);
        let body;
        try {
            body = JSON.parse(ctx.init.body);
        }
        catch {
            return next(ctx);
        }
        if (!Array.isArray(body?.messages))
            return next(ctx);
        body.messages = sanitizeOpenAICompatibleMessages(mergeAssistantMessages(body.messages));
        return next({ ...ctx, init: { ...ctx.init, body: JSON.stringify(body) } });
    };
}
/** Normalize Responses input without applying vendor policy. */
export function createOpenAIResponsesMiddleware() {
    return async (ctx, next) => {
        if (typeof ctx.init?.body !== 'string')
            return next(ctx);
        let body;
        try {
            body = sanitizeResponsesApiBody(JSON.parse(ctx.init.body));
        }
        catch {
            return next(ctx);
        }
        return next({ ...ctx, init: { ...ctx.init, body: JSON.stringify(body) } });
    };
}
//# sourceMappingURL=openai-compatible-middleware.js.map