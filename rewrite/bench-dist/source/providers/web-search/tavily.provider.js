/**
 * Tavily web search provider implementation.
 * Tavily provides high-quality web search results optimized for AI applications.
 *
 * API Documentation: https://docs.tavily.com/
 */
import { registerWebSearchProvider } from './registry.js';
const TAVILY_API_URL = 'https://api.tavily.com/search';
async function searchTavily(query, deps, options = {}) {
    const { settingsService, loggingService } = deps;
    const apiKey = settingsService.get('webSearch.tavily.apiKey');
    if (!apiKey) {
        throw new Error('Tavily API key is not configured. ' +
            'Set TAVILY_API_KEY environment variable or configure webSearch.tavily.apiKey.');
    }
    loggingService.debug('Executing Tavily web search', { query });
    const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            api_key: apiKey,
            query: query,
            ...(options.topic && { topic: options.topic }),
            ...(options.days && { days: options.days }),
            ...(options.maxResults && { max_results: options.maxResults }),
            ...(options.includeDomains && { include_domains: options.includeDomains }),
            ...(options.excludeDomains && { exclude_domains: options.excludeDomains }),
        }),
        signal: options.signal,
    });
    if (!response.ok) {
        const errorText = await response.text();
        loggingService.error('Tavily API error', {
            status: response.status,
            error: errorText,
        });
        throw new Error(`Tavily API error (${response.status}): ${errorText}`);
    }
    const data = (await response.json());
    loggingService.debug('Tavily search completed', {
        resultCount: data.results?.length || 0,
        hasAnswer: !!data.answer,
    });
    return {
        query: data.query,
        results: (data.results || []).map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score,
            publishedDate: r.published_date,
        })),
        answerBox: data.answer,
    };
}
function isConfigured(deps) {
    const apiKey = deps.settingsService.get('webSearch.tavily.apiKey');
    return !!apiKey;
}
// Create the Tavily provider definition
const tavilyProvider = {
    id: 'tavily',
    label: 'Tavily',
    search: searchTavily,
    isConfigured,
    sensitiveSettingKeys: ['webSearch.tavily.apiKey'],
};
// Register the Tavily provider as the default
registerWebSearchProvider(tavilyProvider, { isDefault: true, builtin: true });
// Export for testing purposes
export { tavilyProvider, isConfigured as isTavilyConfigured };
//# sourceMappingURL=tavily.provider.js.map