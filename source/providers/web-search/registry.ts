/**
 * Registry for web search providers.
 * Follows the same pattern as the LLM provider registry.
 */

import type { WebSearchProvider } from './types.js';
import type { ISettingsService } from '../../services/service-interfaces.js';

const providers = new Map<string, WebSearchProvider>();
let defaultProviderId: string | null = null;

/**
 * Register a web search provider
 */
export function registerWebSearchProvider(
    provider: WebSearchProvider,
    options?: { isDefault?: boolean }
): void {
    if (providers.has(provider.id)) {
        throw new Error(`Web search provider '${provider.id}' is already registered`);
    }
    providers.set(provider.id, provider);

    if (options?.isDefault || !defaultProviderId) {
        defaultProviderId = provider.id;
    }
}

/**
 * Get a specific web search provider by ID
 */
export function getWebSearchProvider(id: string): WebSearchProvider | undefined {
    return providers.get(id);
}

/**
 * Get the default web search provider
 */
export function getDefaultWebSearchProvider(): WebSearchProvider | undefined {
    return defaultProviderId ? providers.get(defaultProviderId) : undefined;
}

/**
 * Get all registered web search providers
 */
export function getAllWebSearchProviders(): WebSearchProvider[] {
    return Array.from(providers.values());
}

/**
 * Get the configured provider based on settings, falling back to default
 */
export function getConfiguredWebSearchProvider(
    deps: { settingsService: ISettingsService }
): WebSearchProvider | undefined {
    const providerId = deps.settingsService.get<string>('webSearch.provider');
    if (providerId) {
        const provider = getWebSearchProvider(providerId);
        if (provider) return provider;
    }
    return getDefaultWebSearchProvider();
}

/**
 * Clear all registered providers (useful for testing)
 */
export function clearWebSearchProviders(): void {
    providers.clear();
    defaultProviderId = null;
}
