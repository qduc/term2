import { scoreSubsequence } from '../utils/subsequence-filter.js';
import { getProvider } from '../providers/index.js';
import { getModelContextWindow } from '../providers/model-catalog/catalog.js';
import type { ILoggingService, ISettingsService } from './service-interfaces.js';

export type ModelInfo = {
  id: string;
  name?: string;
  provider: string;
  unavailableReason?: 'missing-credentials' | 'missing-codex-login' | 'missing-grok-login';
  default_reasoning_level?: string;
  /** Context window in tokens from the vendored model catalog, when known. */
  contextWindow?: number;
};

type FetchFn = typeof fetch;

const cache = new Map<string, ModelInfo[]>();

export async function fetchModels(
  deps: {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
    signal?: AbortSignal;
  },
  providerOverride?: string,
  fetchImpl: FetchFn = fetch,
): Promise<ModelInfo[]> {
  const { settingsService, loggingService } = deps;
  const provider = providerOverride || settingsService.get('agent.provider');
  const cacheKey = provider;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) as ModelInfo[];
  }

  try {
    const providerDef = getProvider(provider);
    if (!providerDef) {
      throw new Error(`Provider '${provider}' is not registered`);
    }

    const rawModels = await providerDef.fetchModels(
      { settingsService, loggingService, signal: deps.signal },
      fetchImpl,
    );
    const models: ModelInfo[] = rawModels.map((m) => ({
      ...m,
      provider,
      contextWindow: getModelContextWindow(provider, m.id),
    }));

    cache.set(cacheKey, models);
    return models;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let detailedError = message;
    if (error instanceof Error && error.cause) {
      const causeMessage = error.cause instanceof Error ? error.cause.message : String(error.cause);
      if (causeMessage && causeMessage !== message) {
        detailedError = `${message} (cause: ${causeMessage})`;
      }
    }

    loggingService.warn('Failed to fetch models', {
      provider,
      error: detailedError,
    });

    if (error instanceof Error && error.cause) {
      error.message = detailedError;
    }

    throw error;
  }
}

export function clearModelCache(provider?: string): void {
  if (provider) {
    cache.delete(provider);
  } else {
    cache.clear();
  }
}

export function getModelDefaultReasoningLevel(provider: string, modelId: string): string | undefined {
  const models = cache.get(provider);
  if (!models) return undefined;
  const model = models.find((m) => m.id === modelId);
  return model?.default_reasoning_level;
}

// Providers that reason only when the request explicitly asks them to, and that
// expose no `default_reasoning_level` in their /models response for
// getModelDefaultReasoningLevel() to read. Keyed by lowercased provider id, so a
// custom provider entry named 'Neuralwatt' or 'neuralwatt' both match.
//
// Neuralwatt: verified against api.neuralwatt.com — a bare deepseek-v4-flash
// request returns message keys ['role','content','function_call'] and stream
// deltas ['content','role'], with no reasoning anywhere. Adding
// reasoning_effort makes the model emit a `reasoning` field (note: `reasoning`,
// not `reasoning_content`) on both the message and the deltas.
const PROVIDER_DEFAULT_REASONING_LEVEL: Record<string, string> = {
  neuralwatt: 'high',
};

/**
 * Effort to use for a provider when the user's `agent.reasoningEffort` is
 * 'default'. 'default' otherwise means "send no reasoning_effort and let the
 * API choose", which for these providers means no reasoning at all.
 */
export function getProviderDefaultReasoningLevel(provider: string): string | undefined {
  return PROVIDER_DEFAULT_REASONING_LEVEL[provider.toLowerCase()];
}

export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return models;
  }

  return models
    .map((model) => {
      const idScore = scoreSubsequence(trimmed, model.id);
      const nameScore = model.name ? scoreSubsequence(trimmed, model.name) : -Infinity;

      // Reward ID match more than Name match
      const weightedId = idScore === -Infinity ? -Infinity : idScore * 2;
      const weightedName = nameScore === -Infinity ? -Infinity : nameScore;

      const score = Math.max(weightedId, weightedName);
      return { model, score };
    })
    .filter(({ score }) => score !== -Infinity)
    .map(({ model }) => model);
}
