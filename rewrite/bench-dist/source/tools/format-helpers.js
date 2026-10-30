/**
 * Helper utilities for formatting tool execution results into command messages.
 * These utilities are shared across tool formatters to maintain consistency.
 */
/**
 * Coerces various value types into a text string representation.
 */
export const coerceToText = (value) => {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value
            .filter((part) => {
            // Multimodal tool results can contain large binary payloads. They are
            // sent to the model, but should not be rendered as command text.
            return !(typeof part === 'object' &&
                part !== null &&
                ['image', 'file'].includes(String(part.type)));
        })
            .map((part) => coerceToText(part))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof value === 'object') {
        if ('text' in value && typeof value.text === 'string') {
            return value.text;
        }
        if ('output' in value && typeof value.output === 'string') {
            return value.output;
        }
        try {
            return JSON.stringify(value);
        }
        catch {
            return '';
        }
    }
    return String(value);
};
/**
 * Extracts call ID from various item formats.
 */
export const getCallIdFromItem = (item) => {
    const rawItem = item?.providerItem ?? item?.rawItem ?? item;
    const callId = item?.callId ??
        rawItem?.callId ??
        rawItem?.call_id ??
        rawItem?.tool_call_id ??
        rawItem?.toolCallId ??
        rawItem?.id ??
        item?.callId ??
        item?.call_id ??
        item?.tool_call_id ??
        item?.toolCallId ??
        item?.id ??
        null;
    return typeof callId === 'string' && callId !== 'unknown-call' ? callId : null;
};
/**
 * Extracts output text from various item formats.
 */
export const getOutputText = (item) => {
    const providerItem = item?.providerItem;
    const sources = [item, providerItem, item?.rawItem];
    for (const source of sources) {
        if (!source) {
            continue;
        }
        const outputRecord = source.output && typeof source.output === 'object' ? source.output : undefined;
        for (const candidate of [source.output, outputRecord?.text]) {
            const text = coerceToText(candidate);
            if (text) {
                return text;
            }
        }
    }
    return '';
};
/**
 * Safely parses a JSON string.  Returns `undefined` for non-string,
 * empty, or invalid payloads.
 *
 * Returns `any` because the parsed shape is only known to the caller.
 * The *input* parameter is `unknown`, so untyped data cannot accidentally
 * flow in — the `any` only escapes on the return path where the caller
 * narrows with type guards or `as` assertions.
 */
export const safeJsonParse = (payload) => {
    if (typeof payload !== 'string') {
        return undefined;
    }
    const trimmed = payload.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
};
/**
 * Normalizes tool arguments from various formats.
 *
 * Returns `any` because the output is consumed by per-tool formatters that
 * know their own argument schema and access specific properties by name.
 * The input parameter is typed `unknown` — the `any` only escapes on the
 * return path, which is the narrowest possible `any` surface.
 */
export const normalizeToolArguments = (value) => {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        const parsed = safeJsonParse(value);
        if (parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
        return value;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value;
    }
    return null;
};
/**
 * Picks the most informative display string from a single patch-style result item
 * (`apply_patch` / `search_replace`). Order: explicit error → success message →
 * file path. Returns an empty string when none of those fields are present so
 * callers can filter it out.
 */
export const pickPatchOutputItemText = (item) => {
    if (!item || typeof item !== 'object')
        return '';
    const record = item;
    if (typeof record.error === 'string' && record.error)
        return record.error;
    if (typeof record.message === 'string' && record.message)
        return record.message;
    if (typeof record.path === 'string' && record.path)
        return record.path;
    return '';
};
/**
 * Joins the per-operation text from an array of patch-style result items
 * (`apply_patch` / `search_replace`) using newlines. Used by live tool
 * formatters and by the conversation replay path so the two stay in sync.
 */
export const formatPatchOutputItems = (items) => {
    if (!Array.isArray(items) || items.length === 0)
        return '';
    const parts = [];
    for (const item of items) {
        const text = pickPatchOutputItemText(item);
        if (text)
            parts.push(text);
    }
    return parts.join('\n');
};
/**
 * Generates a stable ID for a command message.
 */
export const generateMessageId = (item, index, subIndex = 0) => {
    const rawItem = item?.providerItem ?? item?.rawItem ?? item;
    const providerId = rawItem?.id ?? rawItem?.callId;
    const baseId = providerId && providerId !== 'unknown-call' ? providerId : getCallIdFromItem(item) ?? `${Date.now()}-${index}`;
    return `${baseId}-${subIndex}`;
};
/**
 * Determines whether a tool output string represents a successful result.
 * Shared across tool formatters so schema-validation failures and JSON error
 * payloads (used by memory tools) are consistently treated as failures.
 */
export const isSuccessOutput = (output) => {
    const trimmed = output.trim();
    if (!trimmed)
        return true;
    if (trimmed.startsWith('Error:'))
        return false;
    if (trimmed.startsWith('Tool input did not match schema'))
        return false;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && 'error' in parsed)
            return false;
    }
    catch {
        // Not JSON — fall through
    }
    return true;
};
/**
 * Creates a base command message with common fields filled in.
 */
export const createBaseMessage = (item, index, subIndex, isApprovalRejection, partial) => {
    const callId = getCallIdFromItem(item);
    return {
        id: generateMessageId(item, index, subIndex),
        sender: 'command',
        status: 'completed',
        isApprovalRejection,
        ...(callId ? { callId } : {}),
        ...partial,
    };
};
//# sourceMappingURL=format-helpers.js.map