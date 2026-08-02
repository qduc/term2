// Import provider registration modules to trigger registration
import './openai.provider.js';
import './openrouter.provider.js';
import './codex.provider.js';

// Import web search provider registration
import './web-search/index.js';

// Re-export registry API and types
export {
  registerProvider,
  upsertProvider,
  unregisterProvider,
  getProvider,
  getAllProviders,
  getProviderIds,
  sortProvidersByOrder,
  type ProviderDefinition,
} from './registry.js';
