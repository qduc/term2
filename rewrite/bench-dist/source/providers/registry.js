const builtinProviders = new Map();
export function createProviderRegistry() {
    const providers = new Map(builtinProviders);
    const registry = {
        registerProvider(definition, options) {
            const allowOverride = options?.allowOverride === true;
            if (providers.has(definition.id) && !allowOverride) {
                throw new Error(`Provider '${definition.id}' is already registered`);
            }
            providers.set(definition.id, definition);
        },
        upsertProvider(definition) {
            registry.registerProvider(definition, { allowOverride: true });
        },
        unregisterProvider(id) {
            providers.delete(id);
        },
        getProvider: (id) => providers.get(id),
        getAllProviders: () => Array.from(providers.values()),
        getProviderIds: () => Array.from(providers.keys()),
    };
    return registry;
}
const defaultProviderRegistry = createProviderRegistry();
/**
 * Register a provider definition.
 * Called by provider modules during initialization.
 */
export function registerProvider(definition, options) {
    if (options?.builtin)
        builtinProviders.set(definition.id, definition);
    defaultProviderRegistry.registerProvider(definition, options);
}
/**
 * Upsert a provider definition.
 *
 * Intended for runtime-defined providers (e.g. user-configured OpenAI-compatible providers).
 */
export function upsertProvider(definition) {
    defaultProviderRegistry.upsertProvider(definition);
}
/**
 * Remove a provider definition.
 *
 * Primarily useful for tests that register runtime providers and need to
 * restore global registry state.
 */
export function unregisterProvider(id) {
    defaultProviderRegistry.unregisterProvider(id);
}
/**
 * Get a specific provider definition by ID.
 * Returns undefined if the provider is not registered.
 */
export function getProvider(id, registry) {
    return (registry ?? defaultProviderRegistry).getProvider(id);
}
/**
 * Get all registered provider definitions.
 */
export function getAllProviders() {
    return defaultProviderRegistry.getAllProviders();
}
/**
 * Get all registered provider IDs.
 */
export function getProviderIds() {
    return defaultProviderRegistry.getProviderIds();
}
//# sourceMappingURL=registry.js.map