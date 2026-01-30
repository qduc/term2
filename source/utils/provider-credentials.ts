import type {ISettingsService} from '../services/service-interfaces.js';
import {
    isCopilotCliAvailable,
    isGhAuthenticated,
} from '../providers/github-copilot/utils.js';

/**
 * Check if a provider has the required credentials configured
 */
export const hasProviderCredentials = (
    settingsService: ISettingsService,
    providerId: string,
): boolean => {
    if (providerId === 'openai') {
        // OpenAI uses OPENAI_API_KEY from the SDK, not from settings
        // We can't check it directly, so assume it might be available
        return true;
    }

    if (providerId === 'openrouter') {
        return !!settingsService.get('agent.openrouter.apiKey');
    }

    if (providerId === 'github-copilot') {
        return isCopilotCliAvailable() && isGhAuthenticated();
    }

    // For unknown providers, assume they're available
    return true;
};

/**
 * Get list of provider IDs that have valid credentials
 */
export const getAvailableProviderIds = (
    settingsService: ISettingsService,
    allProviderIds: string[],
): string[] => {
    return allProviderIds.filter(id =>
        hasProviderCredentials(settingsService, id),
    );
};
