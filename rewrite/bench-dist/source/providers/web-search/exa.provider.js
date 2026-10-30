/**
 * Exa web search provider implementation.
 * Exa (formerly Metaphor) provides neural search and rich text extraction.
 *
 * API Documentation: https://docs.exa.ai/
 */
import { registerWebSearchProvider } from './registry.js';
const EXA_API_URL = 'https://api.exa.ai/search';
async function searchExa(query, deps, options = {}) {
    const { settingsService, loggingService } = deps;
    const apiKey = settingsService.get('webSearch.exa.apiKey');
    if (!apiKey) {
        throw new Error('Exa API key is not configured. ' + 'Set EXA_API_KEY environment variable or configure webSearch.exa.apiKey.');
    }
    loggingService.debug('Executing Exa web search', { query });
    const response = await fetch(EXA_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
        },
        body: JSON.stringify({
            query: query,
            ...(options.maxResults && { numResults: options.maxResults }),
            ...(options.includeDomains && { includeDomains: options.includeDomains }),
            ...(options.excludeDomains && { excludeDomains: options.excludeDomains }),
            contents: {
                highlights: true,
            },
        }),
        signal: options.signal,
    });
    if (!response.ok) {
        const errorText = await response.text();
        loggingService.error('Exa API error', {
            status: response.status,
            error: errorText,
        });
        throw new Error(`Exa API error (${response.status}): ${errorText}`);
    }
    const data = (await response.json());
    loggingService.debug('Exa search completed', {
        resultCount: data.results?.length || 0,
    });
    return {
        query: query,
        results: (data.results || []).map((r) => {
            // Create a concatenated content string from highlights, summary or text
            let content = '';
            if (Array.isArray(r.highlights) && r.highlights.length > 0) {
                content = r.highlights.join('\n...\n');
            }
            else if (r.summary) {
                content = r.summary;
            }
            else if (r.text) {
                content = r.text.substring(0, 1000);
            }
            return {
                title: r.title || r.url,
                url: r.url,
                content: content,
                score: r.score,
                publishedDate: r.publishedDate,
            };
        }),
    };
}
function isConfigured(deps) {
    const apiKey = deps.settingsService.get('webSearch.exa.apiKey');
    return !!apiKey;
}
// Create the Exa provider definition
const exaProvider = {
    id: 'exa',
    label: 'Exa',
    search: searchExa,
    isConfigured,
    sensitiveSettingKeys: ['webSearch.exa.apiKey'],
};
// Register the Exa provider
registerWebSearchProvider(exaProvider, { builtin: true });
// Export for testing purposes
export { exaProvider, isConfigured as isExaConfigured };
//# sourceMappingURL=exa.provider.js.map