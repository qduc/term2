/**
 * Tavily web search provider implementation.
 * Tavily provides high-quality web search results optimized for AI applications.
 *
 * API Documentation: https://docs.tavily.com/
 */

import { registerWebSearchProvider } from './registry.js';
import type { WebSearchProvider, WebSearchResponse, WebSearchDeps } from './types.js';
import type { ISettingsService } from '../../services/service-interfaces.js';

/**
 * Tavily API response structure (relevant fields only)
 */
interface TavilyAPIResponse {
    query: string;
    answer?: string;
    results: Array<{
        title: string;
        url: string;
        content: string;
        score?: number;
        published_date?: string;
    }>;
}

const TAVILY_API_URL = 'https://api.tavily.com/search';

async function searchTavily(
    query: string,
    deps: WebSearchDeps
): Promise<WebSearchResponse> {
    const { settingsService, loggingService } = deps;

    const apiKey = settingsService.get<string>('webSearch.tavily.apiKey');
    if (!apiKey) {
        throw new Error(
            'Tavily API key is not configured. ' +
            'Set TAVILY_API_KEY environment variable or configure webSearch.tavily.apiKey.'
        );
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
            // Leave all other parameters at default values per requirements
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        loggingService.error('Tavily API error', {
            status: response.status,
            error: errorText
        });
        throw new Error(`Tavily API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as TavilyAPIResponse;

    loggingService.debug('Tavily search completed', {
        resultCount: data.results?.length || 0,
        hasAnswer: !!data.answer
    });

    return {
        query: data.query,
        results: (data.results || []).map(r => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score,
            publishedDate: r.published_date,
        })),
        answerBox: data.answer,
    };
}

function isConfigured(deps: { settingsService: ISettingsService }): boolean {
    const apiKey = deps.settingsService.get<string>('webSearch.tavily.apiKey');
    return !!apiKey;
}

// Create the Tavily provider definition
const tavilyProvider: WebSearchProvider = {
    id: 'tavily',
    label: 'Tavily',
    search: searchTavily,
    isConfigured,
    sensitiveSettingKeys: ['webSearch.tavily.apiKey'],
};

// Register the Tavily provider as the default
registerWebSearchProvider(tavilyProvider, { isDefault: true });

// Export for testing purposes
export { tavilyProvider, searchTavily, isConfigured as isTavilyConfigured };
