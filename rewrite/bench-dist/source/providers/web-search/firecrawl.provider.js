import { registerWebSearchProvider } from './registry.js';
const defaultBaseUrl = 'https://api.firecrawl.dev';
const get = (settings, key) => settings.get(key);
async function searchFirecrawl(query, deps, options = {}) {
    const apiKey = get(deps.settingsService, 'webSearch.firecrawl.apiKey');
    const configuredBaseUrl = get(deps.settingsService, 'webSearch.firecrawl.baseUrl');
    if (!apiKey && !configuredBaseUrl) {
        throw new Error('Firecrawl is not configured. Configure webSearch.firecrawl.apiKey or webSearch.firecrawl.baseUrl.');
    }
    const baseUrl = (configuredBaseUrl || defaultBaseUrl).replace(/\/$/, '');
    const queryParts = [query];
    if (options.site)
        queryParts.push(`site:${options.site}`);
    if (options.includeDomains)
        queryParts.push(...options.includeDomains.map((domain) => `site:${domain}`));
    if (options.excludeDomains)
        queryParts.push(...options.excludeDomains.map((domain) => `-site:${domain}`));
    const response = await fetch(`${baseUrl}/v1/search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
            query: queryParts.join(' '),
            ...(options.maxResults ? { limit: options.maxResults } : {}),
        }),
        signal: options.signal,
    });
    if (!response.ok) {
        const text = await response.text();
        deps.loggingService.error('Firecrawl API error', { status: response.status, error: text });
        throw new Error(`Firecrawl API error (${response.status}): ${text}`);
    }
    const data = (await response.json());
    const items = Array.isArray(data.data) ? data.data : data.data?.web || [];
    return {
        query,
        results: items.map((item) => ({
            title: item.title || item.url || 'Untitled',
            url: item.url || '',
            content: item.description || item.markdown?.slice(0, 500) || '',
            publishedDate: undefined,
        })),
    };
}
function isConfigured({ settingsService }) {
    return Boolean(get(settingsService, 'webSearch.firecrawl.apiKey') || get(settingsService, 'webSearch.firecrawl.baseUrl'));
}
export const firecrawlProvider = {
    id: 'firecrawl',
    label: 'Firecrawl',
    search: searchFirecrawl,
    isConfigured,
    sensitiveSettingKeys: ['webSearch.firecrawl.apiKey'],
};
registerWebSearchProvider(firecrawlProvider, { builtin: true });
export { isConfigured as isFirecrawlConfigured };
//# sourceMappingURL=firecrawl.provider.js.map