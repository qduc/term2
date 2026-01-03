/**
 * Types for web search providers.
 * All web search providers must implement the WebSearchProvider interface.
 */

import type { ISettingsService, ILoggingService } from '../../services/service-interfaces.js';

/**
 * Result from a single web search result item
 */
export interface WebSearchResult {
    title: string;
    url: string;
    content: string;       // Snippet or extracted content
    score?: number;        // Relevance score if available
    publishedDate?: string;
}

/**
 * Response from a web search query
 */
export interface WebSearchResponse {
    query: string;
    results: WebSearchResult[];
    answerBox?: string;    // Direct answer if available (Tavily returns this)
}

/**
 * Dependencies passed to web search providers
 */
export interface WebSearchDeps {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
}

/**
 * Interface that all web search providers must implement
 */
export interface WebSearchProvider {
    /** Unique identifier for the provider (e.g., 'tavily', 'serper') */
    id: string;

    /** Human-readable label for display */
    label: string;

    /**
     * Execute a web search query
     * @param query - The search query string
     * @param deps - Dependencies (settings service, logging service)
     * @returns Promise resolving to search results
     */
    search: (
        query: string,
        deps: WebSearchDeps
    ) => Promise<WebSearchResponse>;

    /**
     * Check if the provider is properly configured (has API key, etc.)
     */
    isConfigured: (deps: { settingsService: ISettingsService }) => boolean;

    /** Settings keys that are sensitive (API keys) */
    sensitiveSettingKeys?: string[];
}
