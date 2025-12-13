import {settingsService} from '../services/settings-service.js';

/**
 * Check if a provider has the required credentials configured
 */
export const hasProviderCredentials = (providerId: string): boolean => {
    if (providerId === 'openai') {
        // OpenAI uses OPENAI_API_KEY from the SDK, not from settings
        // We can't check it directly, so assume it might be available
        return true;
    }

    if (providerId === 'openrouter') {
        return !!settingsService.get('agent.openrouter.apiKey');
    }

    // For unknown providers, assume they're available
    return true;
};

/**
 * Get list of provider IDs that have valid credentials
 */
export const getAvailableProviderIds = (allProviderIds: string[]): string[] => {
    return allProviderIds.filter(hasProviderCredentials);
};
