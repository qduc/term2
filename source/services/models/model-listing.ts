import { fetchModels, filterModels, type ModelInfo } from '../model-service.js';
import { getProvider, getProviderIds } from '../../providers/index.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { ModelCatalogSession, orderedProviderIds, type ModelFetcher } from './model-catalog-session.js';
import { scoreSubsequence } from '../../utils/subsequence-filter.js';

/** One provider's selectable models, as the /model picker would load them. */
export type ProviderModelGroup = {
  provider: string;
  label?: string;
  models: ModelInfo[];
  /** Present when the provider's model listing could not be loaded. */
  error?: string;
};

/**
 * Collect each provider's model listing sequentially through
 * ModelCatalogSession, the same loader the interactive /model picker uses, so
 * a standalone listing agrees with what the picker offers. One unreachable
 * provider degrades to an error group instead of failing the whole listing;
 * loads stay sequential because the session marks overlapping loads stale.
 */
export async function collectProviderModels(
  deps: {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
    fetcher?: ModelFetcher;
    signal?: AbortSignal;
    cacheDir?: string;
    now?: () => number;
    ttlMs?: number;
    /**
     * Force a fresh fetch for every provider being listed, bypassing both the
     * in-memory and fresh-disk cache tiers in `fetchModels` (the on-disk
     * last-known-good entry is left alone, so a failed forced fetch cannot
     * destroy usable cached data). Implemented as a `ttlMs: 0` override
     * rather than a new `fetchModels` code path, since `fetchModels` already
     * treats an entry as expired once its age reaches `ttlMs`. Does not
     * affect an injected `fetcher`, which owns its own caching decisions (or
     * none at all).
     */
    forceRefresh?: boolean;
  },
  providerIds?: string[],
): Promise<ProviderModelGroup[]> {
  const session = new ModelCatalogSession({
    settingsService: deps.settingsService,
    loggingService: deps.loggingService,
    fetcher: deps.fetcher,
    signal: deps.signal,
    cacheDir: deps.cacheDir,
    now: deps.now,
    ttlMs: deps.forceRefresh ? 0 : deps.ttlMs,
  });
  const ids = providerIds ?? orderedProviderIds(deps.settingsService, getProviderIds());
  session.begin();
  const groups: ProviderModelGroup[] = [];
  for (const provider of ids) {
    const label = getProvider(provider)?.label;
    try {
      const { models } = await session.load(provider);
      groups.push({ provider, ...(label ? { label } : {}), models });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      groups.push({ provider, ...(label ? { label } : {}), models: [], error: message });
    }
  }
  return groups;
}

export type LoadProviderModelGroupDeps = {
  settingsService: ISettingsService;
  loggingService: ILoggingService;
  fetcher?: ModelFetcher;
  signal?: AbortSignal;
  cacheDir?: string;
  now?: () => number;
  ttlMs?: number;
};

/**
 * Load a single provider's model listing without ModelCatalogSession's
 * overlapping-request staleness tracking. Each call is fully independent (no
 * shared mutable request counter), so unlike `collectProviderModels` this is
 * safe to call concurrently across providers. `ModelCatalogSession` must stay
 * sequential-only because it deliberately marks overlapping loads stale for
 * the interactive picker's superseded-selection semantics; a one-shot CLI
 * resolution has no such concern.
 */
export async function loadProviderModelGroup(
  deps: LoadProviderModelGroupDeps,
  provider: string,
): Promise<ProviderModelGroup> {
  const label = getProvider(provider)?.label;
  const fetcher = deps.fetcher ?? ((p: string) => fetchModels(deps, p));
  try {
    const models = await fetcher(provider);
    return { provider, ...(label ? { label } : {}), models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.loggingService.warn(`Model selection fetch failed for ${provider}`, { error: message });
    return { provider, ...(label ? { label } : {}), models: [], error: message };
  }
}

/**
 * Load several providers' model listings concurrently. Used by the CLI
 * `--model` resolution path once an early exact match hasn't been found and
 * the search must widen to the rest of the credentialed providers; loading
 * them one at a time there would pay each provider's latency serially for no
 * benefit, since a fuzzy/cross-provider match needs every catalog anyway.
 */
export async function collectProviderModelsConcurrently(
  deps: LoadProviderModelGroupDeps,
  providerIds: string[],
): Promise<ProviderModelGroup[]> {
  return Promise.all(providerIds.map((provider) => loadProviderModelGroup(deps, provider)));
}

/**
 * Keep groups whose provider id fuzzy-matches the search (whole provider), and
 * within the rest filter models with the picker's own fuzzy match. Groups left
 * without models are dropped.
 */
export function filterModelGroups(groups: ProviderModelGroup[], search: string): ProviderModelGroup[] {
  const trimmed = search.trim();
  if (!trimmed) return groups;
  return groups
    .map((group) => {
      if (scoreSubsequence(trimmed, group.provider) !== -Infinity) return group;
      return { ...group, models: filterModels(group.models, trimmed) };
    })
    .filter((group) => group.models.length > 0);
}

/** Plain-text listing: `provider (label):` headers, two-space-indented models. */
export function formatModelGroups(groups: ProviderModelGroup[]): string {
  const lines: string[] = [];
  for (const group of groups) {
    if (group.models.length === 0) continue;
    const header =
      group.label && group.label !== group.provider ? `${group.provider} (${group.label})` : group.provider;
    lines.push(`${header}:`);
    for (const model of group.models) {
      const name = model.name && model.name !== model.id ? `  ${model.name}` : '';
      lines.push(`  ${model.id}${name}`);
    }
  }
  return lines.join('\n');
}

export type ListModelsOutcome = {
  exitCode: number;
  /** Plain-text listing for stdout; null when nothing is available. */
  output: string | null;
  /** Single-line no-results explanation for stderr. */
  error: string | null;
  /** Per-provider listing failures, for stderr. */
  warnings: string[];
};

/** Build the `--list-models` output without touching stdout/stderr. */
export async function runListModels(deps: {
  settingsService: ISettingsService;
  loggingService: ILoggingService;
  search?: string;
  fetcher?: ModelFetcher;
  providerIds?: string[];
  signal?: AbortSignal;
  cacheDir?: string;
  now?: () => number;
  ttlMs?: number;
  /** Force a fresh fetch for every listed provider; see `collectProviderModels`'s `forceRefresh`. */
  refresh?: boolean;
}): Promise<ListModelsOutcome> {
  const groups = await collectProviderModels(
    {
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
      signal: deps.signal,
      cacheDir: deps.cacheDir,
      now: deps.now,
      ttlMs: deps.ttlMs,
      forceRefresh: deps.refresh,
    },
    deps.providerIds,
  );
  const warnings = groups
    .filter((group) => group.error !== undefined)
    .map((group) => `warning: ${group.provider}: ${group.error}`);
  const printable = filterModelGroups(groups, deps.search ?? '').filter((group) => group.models.length > 0);
  if (printable.length === 0) {
    const search = deps.search?.trim();
    return {
      exitCode: 1,
      output: null,
      error: search ? `No models match "${search}".` : 'No models available.',
      warnings,
    };
  }
  return { exitCode: 0, output: formatModelGroups(printable), error: null, warnings };
}
