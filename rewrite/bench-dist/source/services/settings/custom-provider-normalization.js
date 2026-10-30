import { isKnownCustomProviderType } from './settings-schema.js';
export const normalizeProviderIdentifier = (value) => value.trim().replace(/\s+/g, '_');
export const resolveProviderId = (entry) => {
    if (!entry || typeof entry !== 'object' || entry === null)
        return undefined;
    const record = entry;
    const raw = (typeof record.id === 'string' && record.id) ||
        (typeof record.identifier === 'string' && record.identifier) ||
        (typeof record.name === 'string' && record.name) ||
        (typeof record.displayName === 'string' && record.displayName) ||
        undefined;
    if (!raw)
        return undefined;
    const normalized = normalizeProviderIdentifier(raw);
    return normalized.length > 0 ? normalized : undefined;
};
export const resolveProviderName = (entry, fallbackId) => {
    if (!entry || typeof entry !== 'object' || entry === null)
        return fallbackId;
    const record = entry;
    const raw = (typeof record.name === 'string' && record.name) ||
        (typeof record.displayName === 'string' && record.displayName) ||
        fallbackId;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : fallbackId;
};
const decodeStoredCustomProviderConfig = (entry) => {
    if (!entry || typeof entry !== 'object' || entry === null)
        return null;
    const id = resolveProviderId(entry);
    if (!id)
        return null;
    const record = entry;
    const name = resolveProviderName(entry, id);
    const rawType = typeof record.type === 'string' ? record.type : 'openai-compatible';
    const type = isKnownCustomProviderType(rawType) ? rawType : 'openai-compatible';
    const baseUrl = typeof record.baseUrl === 'string' && record.baseUrl.trim().length > 0 ? record.baseUrl.trim() : undefined;
    const apiKey = typeof record.apiKey === 'string' && record.apiKey.trim().length > 0 ? record.apiKey.trim() : undefined;
    return {
        id,
        name,
        type,
        baseUrl,
        apiKey,
    };
};
export const decodeStoredCustomProviderConfigs = (raw) => {
    if (!Array.isArray(raw))
        return [];
    const results = [];
    for (const item of raw) {
        const decoded = decodeStoredCustomProviderConfig(item);
        if (decoded) {
            results.push(decoded);
        }
    }
    return results;
};
//# sourceMappingURL=custom-provider-normalization.js.map