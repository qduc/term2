/**
 * Web search provider module.
 * Import this module to register all web search providers.
 */

// Import provider modules to trigger registration
import './tavily.provider.js';

// Re-export registry API and types
export {
    registerWebSearchProvider,
    getWebSearchProvider,
    getDefaultWebSearchProvider,
    getAllWebSearchProviders,
    getConfiguredWebSearchProvider,
    clearWebSearchProviders,
} from './registry.js';

export type {
    WebSearchProvider,
    WebSearchResponse,
    WebSearchResult,
    WebSearchDeps,
} from './types.js';
