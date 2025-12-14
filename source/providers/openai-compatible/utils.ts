export function normalizeBaseUrl(baseUrl: string): string {
    const trimmed = String(baseUrl || '').trim();
    // Remove trailing slashes to make URL joins predictable.
    return trimmed.replace(/\/+$/g, '');
}

export function buildOpenAICompatibleUrl(baseUrl: string, path: string): string {
    const normalized = normalizeBaseUrl(baseUrl);
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalized}${normalizedPath}`;
}
