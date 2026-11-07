import { clearModelCache, fetchModels, type ModelInfo, type FetchModelsDeps } from '../model-service.js';
import { getProviderIds } from '../providers/index.js';
import type { ILoggingService, ISettingsService } from '../../shared/service-interfaces.js';
import { getAvailableProviderIds, isProviderDisabled } from '../provider-credentials.js';

export type ModelFetcher = (provider: string) => Promise<ModelInfo[]>;

/**
 * Provider ids the model pickers and catalog listings may show, in registry
 * order: credential-available providers minus the ones the user disabled via
 * provider management (agent.disabledProviders). This is the single seam —
 * every picker and listing composes its provider set through here.
 */
export const orderedProviderIds = (settingsService: ISettingsService, providerIds: string[]): string[] =>
  getAvailableProviderIds(settingsService, providerIds).filter((id) => !isProviderDisabled(settingsService, id));

/** Owns model-catalog traversal, per-open caching, failed-provider suppression, and stale loads. */
export class ModelCatalogSession {
  readonly #settingsService: ISettingsService;
  readonly #loggingService: ILoggingService;
  readonly #fetcher: ModelFetcher;
  readonly #clearCache: (provider: string) => void;
  readonly #modelsByProvider = new Map<string, ModelInfo[]>();
  readonly #failedProviders = new Set<string>();
  readonly #requestIds = new Map<string, number>();
  #generation = 0;

  constructor(deps: FetchModelsDeps & { fetcher?: ModelFetcher }) {
    this.#settingsService = deps.settingsService;
    this.#loggingService = deps.loggingService;
    this.#fetcher = deps.fetcher ?? ((provider) => fetchModels(deps, provider));
    this.#clearCache = deps.discovery
      ? (provider) => {
          deps.discovery!.cache.delete(provider);
        }
      : (provider) => clearModelCache(provider, { cacheDir: deps.cacheDir });
  }

  getCached(provider: string): ModelInfo[] | undefined {
    return this.#modelsByProvider.get(provider);
  }

  async load(provider: string): Promise<{ kind: 'loaded' | 'cached' | 'stale'; models: ModelInfo[] }> {
    const cached = this.#modelsByProvider.get(provider);
    if (cached) return { kind: 'cached', models: cached };
    const generation = this.#generation;
    const requestId = (this.#requestIds.get(provider) ?? 0) + 1;
    this.#requestIds.set(provider, requestId);
    const isCurrent = () => generation === this.#generation && this.#requestIds.get(provider) === requestId;
    try {
      const models = await this.#fetcher(provider);
      if (!isCurrent()) return { kind: 'stale', models: [] };
      this.#modelsByProvider.set(provider, models);
      return { kind: 'loaded', models };
    } catch (error) {
      if (!isCurrent()) return { kind: 'stale', models: [] };
      this.#failedProviders.add(provider);
      const message = error instanceof Error ? error.message : String(error);
      this.#loggingService.warn(`Model selection fetch failed for ${provider}`, { error: message });
      throw error;
    }
  }

  shouldRetry(provider: string, initialLoad: boolean): boolean {
    return initialLoad || !this.#failedProviders.has(provider);
  }

  begin(): void {
    this.#generation++;
    this.#failedProviders.clear();
  }

  refresh(provider: string): void {
    this.invalidate(provider);
  }

  /** Invalidate provider state when its credential/readiness boundary changes. */
  invalidate(provider: string): void {
    this.#failedProviders.delete(provider);
    this.#modelsByProvider.delete(provider);
    this.#requestIds.set(provider, (this.#requestIds.get(provider) ?? 0) + 1);
    this.#clearCache(provider);
  }

  nextProvider(current: string | null, direction: 'next' | 'prev'): string | undefined {
    const ordered = orderedProviderIds(this.#settingsService, getProviderIds());
    if (ordered.length === 0) return undefined;
    const currentIndex = ordered.indexOf(current ?? '');
    if (currentIndex < 0) return direction === 'prev' ? ordered.at(-1) : ordered[0];
    const safeIndex = currentIndex;
    const offset = direction === 'prev' ? -1 : 1;
    return ordered[(safeIndex + offset + ordered.length) % ordered.length];
  }

  clear(): void {
    this.#generation++;
    this.#modelsByProvider.clear();
    this.#failedProviders.clear();
  }
}
