import { z } from 'zod';
export const LOG_CATEGORIES = ['provider', 'tool', 'stream', 'approval', 'retry', 'general'];
export const RuntimeLogSchema = z
    .object({
    timestamp: z.string().min(1),
    level: z.string().min(1),
    eventType: z.string().min(1),
    traceId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    messageId: z.string().min(1),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    retryType: z.string().min(1).optional(),
    retryAttempt: z.number().int().nonnegative().optional(),
    errorCode: z.string().min(1).optional(),
    errorMessage: z.string().min(1).optional(),
    payloadRef: z.string().min(1).optional(),
})
    .passthrough();
const looksLikeUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const EVENT_CATEGORY_PREFIXES = [
    { prefix: 'provider.', category: 'provider' },
    { prefix: 'tool_call.', category: 'tool' },
    { prefix: 'tool.', category: 'tool' },
    { prefix: 'stream.', category: 'stream' },
    { prefix: 'approval.', category: 'approval' },
    { prefix: 'retry.', category: 'retry' },
];
export const resolveLogCategory = ({ eventType, explicitCategory, }) => {
    if (typeof explicitCategory === 'string' && LOG_CATEGORIES.includes(explicitCategory)) {
        return explicitCategory;
    }
    if (typeof eventType !== 'string' || !eventType.trim()) {
        return 'general';
    }
    for (const entry of EVENT_CATEGORY_PREFIXES) {
        if (eventType.startsWith(entry.prefix)) {
            return entry.category;
        }
    }
    return 'general';
};
const toNonEmptyString = (value, fallback) => {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    return fallback;
};
const buildMessageId = (meta) => {
    const candidate = meta.messageId;
    if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
    }
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};
export const buildRuntimeLogRecord = ({ timestamp, level, correlationId, meta = {}, }) => {
    const eventType = toNonEmptyString(meta.eventType, 'log.message');
    const rawProvider = toNonEmptyString(meta.provider, 'unknown');
    const rawModel = toNonEmptyString(meta.model, 'unknown');
    const rawSessionId = toNonEmptyString(meta.sessionId, 'session-unknown');
    const rawTraceId = toNonEmptyString(meta.traceId ?? correlationId, 'trace-unknown');
    const record = {
        ...meta,
        timestamp: timestamp ?? new Date().toISOString(),
        level,
        eventType,
        messageId: buildMessageId(meta),
    };
    delete record.provider;
    delete record.model;
    delete record.sessionId;
    delete record.traceId;
    if (rawProvider !== 'unknown')
        record.provider = rawProvider;
    if (rawModel !== 'unknown')
        record.model = rawModel;
    if (rawSessionId !== 'session-unknown')
        record.sessionId = rawSessionId;
    let finalTrace = rawTraceId;
    if (!looksLikeUuid(rawTraceId) && correlationId && looksLikeUuid(correlationId)) {
        finalTrace = correlationId;
    }
    if (finalTrace !== 'trace-unknown')
        record.traceId = finalTrace;
    delete record.category;
    delete record.phase;
    return record;
};
export const parseCategoryFilter = (raw) => {
    if (!raw || !raw.trim()) {
        return null;
    }
    const values = raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => LOG_CATEGORIES.includes(part));
    if (!values.length) {
        return null;
    }
    return new Set(values);
};
export const shouldLogForCategory = ({ level, category, enabledCategories, }) => {
    if (!enabledCategories || enabledCategories.size === 0) {
        return true;
    }
    if (level === 'error' || level === 'warn') {
        return true;
    }
    return enabledCategories.has(category);
};
export const shouldIncludeVerbosePayload = ({ level, verbosePayloads, }) => {
    if (verbosePayloads) {
        return true;
    }
    return level === 'error';
};
export const shouldSampleLog = ({ level, sampleRate, randomValue, }) => {
    if (level === 'error' || level === 'warn') {
        return true;
    }
    if (!Number.isFinite(sampleRate) || sampleRate >= 1) {
        return true;
    }
    if (sampleRate <= 0) {
        return false;
    }
    return randomValue <= sampleRate;
};
export const createInvalidToolCallDiagnostic = ({ toolName, toolCallId, rawPayload, normalizedToolCall, validationErrors, traceId, retryContext, }) => {
    return {
        eventType: 'tool_call.parse_failed',
        errorCode: 'INVALID_TOOL_CALL_FORMAT',
        errorMessage: 'Invalid tool call argument payload',
        toolName,
        toolCallId,
        traceId,
        rawPayloadSnippet: rawPayload.slice(0, 500),
        normalizedToolCall,
        validationErrors,
        retryContext,
    };
};
//# sourceMappingURL=logging-contract.js.map