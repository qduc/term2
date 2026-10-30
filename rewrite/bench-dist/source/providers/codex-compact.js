import { OPENAI_RESPONSES_OPAQUE_TAG } from './provider-opaque-compatibility.js';
/** Explicit compact-endpoint incompatibility, not a transient or history error. */
export function isCodexCompactionIncompatible(error) {
    if (!error || typeof error !== 'object')
        return false;
    const record = error;
    const status = record.status ?? record.statusCode;
    if (status === 404 || status === 405)
        return true;
    if (status !== 400 && status !== 422)
        return false;
    const message = [record.message, record.error?.message].filter((value) => typeof value === 'string').join(' ');
    return (/compaction_trigger|context_management|parallel_tool_calls|reasoning\.context/i.test(message) &&
        /unsupported|not support|requires|unknown (?:field|parameter)|unrecognized/i.test(message));
}
/**
 * Codex (chatgpt.com) does not accept Responses `context_management` on ordinary
 * turns. Compaction uses the Responses endpoint with a trailing
 * `{ type: 'compaction_trigger' }`, which returns one opaque
 * `{ type: 'compaction' }` output item. Pass that artifact through as the next
 * request's history.
 */
export function compactOutputToProviderHistory(output) {
    return output.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('Codex compact output contained a non-object item');
        }
        const record = item;
        if (record.type === 'compaction') {
            return {
                ...record,
                providerOpaque: { provider: OPENAI_RESPONSES_OPAQUE_TAG, sourceProvider: 'codex' },
            };
        }
        return record;
    });
}
//# sourceMappingURL=codex-compact.js.map