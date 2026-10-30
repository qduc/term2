import { trimOutput } from './output-trim.js';
const tryParseJson = (value) => {
    if (!value.trim()) {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
};
const trimStringValue = (value, maxLines, maxCharacters) => {
    if (!value) {
        return value;
    }
    return trimOutput(value, maxLines, maxCharacters);
};
const trimJsonStrings = (value, maxLines, maxCharacters) => {
    if (typeof value === 'string') {
        return trimStringValue(value, maxLines, maxCharacters);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => trimJsonStrings(entry, maxLines, maxCharacters));
    }
    if (value && typeof value === 'object') {
        const record = value;
        const next = {};
        for (const [key, entry] of Object.entries(record)) {
            next[key] = trimJsonStrings(entry, maxLines, maxCharacters);
        }
        return next;
    }
    return value;
};
/**
 * True for a multimodal tool result: a non-empty array whose every entry is an
 * object carrying a string `type` discriminator, the shape the provider
 * converters know how to serialize.
 */
const isContentPartArray = (value) => Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === 'object' && part !== null && typeof part.type === 'string');
export const trimToolOutput = (output, maxLines, maxCharacters) => {
    if (typeof output !== 'string') {
        // A structured content-part result (read_file returns
        // `[{type:'text'},{type:'image'},...]` for images) is not text to be
        // trimmed. Return it unmodified — trimming string leaves would truncate an
        // image's base64 `data` and corrupt it, and coercing via String() would
        // flatten the array to "[object Object],[object Object]".
        //
        // Only content-part arrays get this exemption. Any other array keeps the
        // old String() coercion, so a tool returning arbitrary objects does not
        // silently escape the size limit or reach a converter that rejects it.
        if (isContentPartArray(output)) {
            return output;
        }
        return String(output ?? '');
    }
    const parsed = tryParseJson(output);
    if (parsed !== null) {
        const trimmed = trimJsonStrings(parsed, maxLines, maxCharacters);
        try {
            return JSON.stringify(trimmed);
        }
        catch {
            return trimStringValue(output, maxLines, maxCharacters);
        }
    }
    return trimStringValue(output, maxLines, maxCharacters);
};
//# sourceMappingURL=trim-tool-output.js.map