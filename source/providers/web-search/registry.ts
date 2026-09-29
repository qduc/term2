/**
 * Registry for web search providers.
 * Follows the same pattern as the LLM provider registry.
 */

import type { WebSearchProvider } from './types.js';
import type { ISettingsService } from '../../services/service-interfaces.js';

export interface WebSearchRegistry {
  registerWebSearchProvider(provider: WebSearchProvider, options?: { isDefault?: boolean }): void;
  getWebSearchProvider(id: string): WebSearchProvider | undefined;
  getDefaultWebSearchProvider(): WebSearchProvider | undefined;
  getAllWebSearchProviders(): WebSearchProvider[];
  getConfiguredWebSearchProvider(deps: { settingsService: ISettingsService }): WebSearchProvider | undefined;
  clearWebSearchProviders(): void;
}

const builtinProviders = new Map<string, WebSearchProvider>();
let builtinDefaultProviderId: string | null = null;

export function createWebSearchRegistry(): WebSearchRegistry {
  const providers = new Map(builtinProviders);
  let defaultProviderId = builtinDefaultProviderId;
  const registry: WebSearchRegistry = {
    registerWebSearchProvider(provider, options) {
      if (providers.has(provider.id)) {
        throw new Error(`Web search provider '${provider.id}' is already registered`);
      }
      providers.set(provider.id, provider);
      if (options?.isDefault || !defaultProviderId) defaultProviderId = provider.id;
    },
    getWebSearchProvider: (id) => providers.get(id),
    getDefaultWebSearchProvider: () => (defaultProviderId ? providers.get(defaultProviderId) : undefined),
    getAllWebSearchProviders: () => Array.from(providers.values()),
    getConfiguredWebSearchProvider: (deps) => {
      const providerId = deps.settingsService.get('webSearch.provider');
      if (providerId) {
        const provider = providers.get(providerId);
        if (provider) return provider;
      }
      return defaultProviderId ? providers.get(defaultProviderId) : undefined;
    },
    clearWebSearchProviders: () => {
      providers.clear();
      defaultProviderId = null;
    },
  };
  return registry;
}

const defaultWebSearchRegistry = createWebSearchRegistry();

/**
 * Register a web search provider
 */
export function registerWebSearchProvider(
  provider: WebSearchProvider,
  options?: { isDefault?: boolean; builtin?: boolean },
): void {
  if (options?.builtin) {
    builtinProviders.set(provider.id, provider);
    if (options.isDefault || !builtinDefaultProviderId) builtinDefaultProviderId = provider.id;
  }
  defaultWebSearchRegistry.registerWebSearchProvider(provider, options);
}

/**
 * Get a specific web search provider by ID
 */
export function getWebSearchProvider(id: string): WebSearchProvider | undefined {
  return defaultWebSearchRegistry.getWebSearchProvider(id);
}

/**
 * Get the default web search provider
 */
export function getDefaultWebSearchProvider(): WebSearchProvider | undefined {
  return defaultWebSearchRegistry.getDefaultWebSearchProvider();
}

/**
 * Get all registered web search providers
 */
export function getAllWebSearchProviders(): WebSearchProvider[] {
  return defaultWebSearchRegistry.getAllWebSearchProviders();
}

/**
 * Get the configured provider based on settings, falling back to default
 */
export function getConfiguredWebSearchProvider(deps: {
  settingsService: ISettingsService;
}): WebSearchProvider | undefined {
  const providerId = deps.settingsService.get('webSearch.provider');
  if (providerId) {
    const provider = defaultWebSearchRegistry.getWebSearchProvider(providerId);
    if (provider) return provider;
  }
  return defaultWebSearchRegistry.getDefaultWebSearchProvider();
}

/**
 * Clear all registered providers (useful for testing)
 */
export function clearWebSearchProviders(): void {
  defaultWebSearchRegistry.clearWebSearchProviders();
}
