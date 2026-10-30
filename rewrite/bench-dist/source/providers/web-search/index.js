/**
 * Web search provider module.
 * Import this module to register all web search providers.
 */
// Import provider modules to trigger registration
import './tavily.provider.js';
import './exa.provider.js';
import './firecrawl.provider.js';
import './searxng.provider.js';
// Re-export registry API and types
export { createWebSearchRegistry, getConfiguredWebSearchProvider } from './registry.js';
//# sourceMappingURL=index.js.map