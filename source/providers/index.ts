// Import provider registration modules to trigger registration
import './openai.provider.js';
import './openrouter.provider.js';

// Re-export registry API and types
export {
    registerProvider,
    getProvider,
    getAllProviders,
    getProviderIds,
    type ProviderDefinition,
} from './registry.js';
