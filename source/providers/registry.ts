import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import type { ISessionContextService } from '../services/service-interfaces.js';
import type { ProviderRequestCapture } from './provider-request-capture.js';
import type { ContextCompactionSessionState, StreamedModelTurn } from '../contracts/streamed-model-turn.js';

export interface ProviderDeps {
  settingsService: ISettingsService;
  loggingService: ILoggingService;
  sessionContextService?: ISessionContextService;
  /** Abort signal for provider discovery or model preparation. */
  signal?: AbortSignal;
  onRetry?: () => void;
  /** Per-client retry budget for direct streamed models. */
  retryAttempts?: number;
  /** Root-session-only observational seam. Omitted for all other clients. */
  requestCapture?: ProviderRequestCapture;
  /** Session-owned state for disabling unsupported server-side compaction. */
  contextCompactionSessionState?: ContextCompactionSessionState;
}

/** The real fetch contract used by provider model listing and token refresh. */
export type ProviderFetch = typeof fetch;

/**
 * Defines the interface for a provider in the registry.
 * Each provider specifies how to create runners, fetch models, and other provider-specific behaviors.
 */
export interface ProviderDefinition {
  /** Unique identifier for the provider (e.g., 'openai', 'openrouter') */
  id: string;

  /** Human-readable label for display (e.g., 'OpenAI', 'OpenRouter') */
  label: string;

  /** Application-owned one-turn model factory. */
  createStreamedModel?: (model: string, deps: ProviderDeps) => StreamedModelTurn | Promise<StreamedModelTurn>;

  /** Function to fetch available models for this provider */
  fetchModels: (
    deps: ProviderDeps,
    fetchImpl?: ProviderFetch,
  ) => Promise<Array<{ id: string; name?: string; default_reasoning_level?: string }>>;

  /** Optional function to clear conversation state for this provider */
  clearConversations?: () => void;

  /** Settings keys that are sensitive and should not be persisted to disk */
  sensitiveSettingKeys?: string[];

  /** Optional provider capabilities */
  capabilities?: {
    supportsConversationChaining: boolean;
    /** Supports the OpenAI Responses API's server-side context_management parameter. */
    supportsContextCompaction?: boolean;
    supportsPromptCacheKey?: boolean;
    /**
     * Where the prompt cache key belongs on the wire, which follows the
     * adapter rather than the provider name. `responses-extra-body` is read by
     * the OpenAI Responses adapter; the default Codex placement is read by the
     * Codex adapter. Routing this by provider id silently dropped the key for
     * any new provider on the Responses adapter.
     */
    promptCacheKeyPlacement?: 'responses-extra-body' | 'codex';
    usesStrictToolSchema?: boolean;
    nativePatchModelPrefixes?: readonly string[];
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
 * Remove a provider definition.
 *
 * Primarily useful for tests that register runtime providers and need to
 * restore global registry state.
 */
export function unregisterProvider(id: string): void {
  providers.delete(id);
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

/**
 * Sort provider IDs according to a preferred order.
 * Providers listed in `providerOrder` appear first (in that order);
 * any providers not in the list are appended afterward in their original order.
 */
export function sortProvidersByOrder(providerIds: string[], providerOrder: string[]): string[] {
  if (!providerOrder || providerOrder.length === 0) return providerIds;

  const orderIndex = new Map<string, number>();
  providerOrder.forEach((id, idx) => orderIndex.set(id, idx));

  return [...providerIds].sort((a, b) => {
    const aIdx = orderIndex.get(a);
    const bIdx = orderIndex.get(b);
    // Both in providerOrder: sort by their position
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    // Only one in providerOrder: the one with order comes first
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    // Neither in providerOrder: keep original relative order
    return 0;
  });
}
