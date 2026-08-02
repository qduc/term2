import type { LegacyRunner } from '../contracts/model.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import type { ISessionContextService } from '../services/service-interfaces.js';
import type { ProviderRequestCapture } from './provider-request-capture.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';

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
}

export type ProviderFetch = (url: string, options?: any) => Promise<any>;

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
  createRunner?: (deps: ProviderDeps) => LegacyRunner | null;

  /** Application-owned one-turn model path used by the replacement run loop. */
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
    supportsTracingControl: boolean;
    supportsPromptCacheKey?: boolean;
    usesStrictToolSchema?: boolean;
    nativePatchModelPrefixes?: string[];
  };

  /**
   * True when this provider is defined at runtime (e.g. from settings.json).
   * Used to prevent accidental overrides of built-in providers.
   */
  isRuntimeDefined?: boolean;
}

export function createApplicationCompatibilityRunner(
  createModel: (model: string) => unknown | Promise<unknown>,
): ApplicationCompatibilityRunner {
  const models = new Map<string, unknown>();
  const modelProvider = {
    getModel: async (model: string) => {
      const cached = models.get(model);
      if (cached) return cached;
      const created = await createModel(model);
      models.set(model, created);
      return created;
    },
  };
  return {
    config: { modelProvider },
    async run(agent: any, input: unknown, options: any = {}) {
      const { ApplicationRunLoop } = await import('../services/agent-runtime/application-run-loop.js');
      const loop = new ApplicationRunLoop({ resolveModel: (model: string) => modelProvider.getModel(model) as any });
      return loop.startStream(agent, input as any, {
        signal: options.signal,
        ...(options.previousResponseId ? { previousResponseId: options.previousResponseId } : {}),
        // Callers that had a turn budget under the SDK runner (the mentor, edit
        // healing) still pass it in run options; the loop enforces it now.
        ...(typeof options.maxTurns === 'number' ? { maxTurns: options.maxTurns } : {}),
      });
    },
    async runToCompletion(agent: any, input: unknown, options: any = {}) {
      // Settle the stream so result-shaped callers (edit healing, the mentor)
      // can read `finalOutput` / `usage` synchronously instead of reading a
      // stream that has not run yet. The resolved completion value carries the
      // run's `{ usage, output }`; attach it to the returned stream.
      const stream = await this.run(agent, input, options);
      const resolved = await stream.completed;
      return Object.assign(stream, resolved);
    },
  } as any;
}

export interface ApplicationCompatibilityRunner extends LegacyRunner {
  /**
   * Runs the same application loop as {@link LegacyRunner.run} but awaits the
   * stream to completion and returns the settled stream (with the resolved
   * `{ usage, output }` attached). Result-shaped callers must use this; `run`
   * returns a live stream and is reserved for the streaming main path.
   */
  runToCompletion(agent: unknown, input: unknown, options?: any): Promise<any>;
}

/**
 * Runs a provider runner and returns a settled, result-shaped run.
 *
 * Every registered provider's runner comes from
 * {@link createApplicationCompatibilityRunner} and therefore has
 * `runToCompletion`; runners that only expose the live-stream `run` (test
 * fakes, hand-built runners) are settled here instead. Result-shaped callers
 * share this so they cannot drift apart on which shape they tolerate.
 */
export async function settleProviderRun(
  runner: LegacyRunner,
  agent: unknown,
  input: unknown,
  options?: any,
): Promise<any> {
  const compatRunner = runner as ApplicationCompatibilityRunner;
  if (typeof compatRunner.runToCompletion === 'function') {
    return compatRunner.runToCompletion(agent, input, options);
  }
  const liveStream = await runner.run(agent as any, input as any, options);
  if (liveStream?.completed) {
    return Object.assign(liveStream, await liveStream.completed);
  }
  return liveStream;
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
  if (!definition.createRunner && definition.createStreamedModel) {
    definition.createRunner = (deps) =>
      createApplicationCompatibilityRunner((model) => definition.createStreamedModel!(model, deps));
  }
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
