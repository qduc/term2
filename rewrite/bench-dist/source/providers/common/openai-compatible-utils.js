export function normalizeBaseUrl(baseUrl) {
    const trimmed = String(baseUrl || '').trim();
    return trimmed.replace(/\/+$/g, '');
}
export function buildOpenAICompatibleUrl(baseUrl, path) {
    const normalized = normalizeBaseUrl(baseUrl);
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalized}${normalizedPath}`;
}
//# sourceMappingURL=openai-compatible-utils.js.map