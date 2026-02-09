import type { Runner } from '@openai/agents';

/**
 * Defines the interface for a provider in the registry.
 * Each provider specifies how to create runners, fetch models, and other provider-specific behaviors.
 */
export interface ProviderDefinition {
  /** Unique identifier for the provider (e.g., 'openai', 'openrouter') */
  id: string;

  /** Human-readable label for display (e.g., 'OpenAI', 'OpenRouter') */
  label: string;

  /**
   * Factory function to create a Runner instance, or undefined to use SDK default.
   *
   * NOTE: This accepts dependencies from the caller to avoid providers importing
   * services directly (which can create ESM circular dependency issues).
   */
  createRunner?: (deps: { settingsService: any; loggingService: any }) => Runner | null;

  /** Function to fetch available models for this provider */
  fetchModels: (
    deps: { settingsService: any; loggingService: any },
    fetchImpl?: (url: string, options?: any) => Promise<any>,
  ) => Promise<Array<{ id: string; name?: string }>>;

  /** Optional function to clear conversation state for this provider */
  clearConversations?: () => void;

  /** Settings keys that are sensitive and should not be persisted to disk */
  sensitiveSettingKeys?: string[];

  /** Optional provider capabilities */
  capabilities?: {
    supportsConversationChaining: boolean;
    supportsTracingControl: boolean;
  };

  /**
   * True when this provider is defined at runtime (e.g. from settings.json).
   * Used to prevent accidental overrides of built-in providers.
   */
  isRuntimeDefined?: boolean;
}

/**
 * Global registry of providers.
 * Providers register themselves by calling registerProvider() on module load.
 */
const providers = new Map<string, ProviderDefinition>();

/**
 * Register a provider definition.
 * Called by provider modules during initialization.
 */
export function registerProvider(definition: ProviderDefinition, options?: { allowOverride?: boolean }): void {
  const allowOverride = options?.allowOverride === true;

  if (providers.has(definition.id) && !allowOverride) {
    throw new Error(`Provider '${definition.id}' is already registered`);
  }
  providers.set(definition.id, definition);
}

/**
 * Upsert a provider definition.
 *
 * Intended for runtime-defined providers (e.g. user-configured OpenAI-compatible providers).
 */
export function upsertProvider(definition: ProviderDefinition): void {
  registerProvider(definition, { allowOverride: true });
}

/**
 * Get a specific provider definition by ID.
 * Returns undefined if the provider is not registered.
 */
export function getProvider(id: string): ProviderDefinition | undefined {
  return providers.get(id);
}

/**
 * Get all registered provider definitions.
 */
export function getAllProviders(): ProviderDefinition[] {
  return Array.from(providers.values());
}

/**
 * Get all registered provider IDs.
 */
export function getProviderIds(): string[] {
  return Array.from(providers.keys());
}
