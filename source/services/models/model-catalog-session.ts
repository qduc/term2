import { clearModelCache, fetchModels, type ModelInfo } from '../model-service.js';
import { getProviderIds, sortProvidersByOrder } from '../../providers/index.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { getAvailableProviderIds } from '../../utils/ai/provider-credentials.js';

export type ModelFetcher = (provider: string) => Promise<ModelInfo[]>;

/** Owns model-catalog traversal, per-open caching, failed-provider suppression, and stale loads. */
export class ModelCatalogSession {
  readonly #settingsService: ISettingsService;
  readonly #loggingService: ILoggingService;
  readonly #fetcher: ModelFetcher;
  readonly #modelsByProvider = new Map<string, ModelInfo[]>();
  readonly #failedProviders = new Set<string>();
  #requestId = 0;

  constructor(deps: { settingsService: ISettingsService; loggingService: ILoggingService; fetcher?: ModelFetcher }) {
    this.#settingsService = deps.settingsService;
    this.#loggingService = deps.loggingService;
    this.#fetcher = deps.fetcher ?? ((provider) => fetchModels(deps, provider));
  }

  getCached(provider: string): ModelInfo[] | undefined {
    return this.#modelsByProvider.get(provider);
  }

  async load(provider: string): Promise<{ kind: 'loaded' | 'cached' | 'stale'; models: ModelInfo[] }> {
    const cached = this.#modelsByProvider.get(provider);
    if (cached) return { kind: 'cached', models: cached };
    const requestId = ++this.#requestId;
    try {
      const models = await this.#fetcher(provider);
      if (requestId !== this.#requestId) return { kind: 'stale', models: [] };
      this.#modelsByProvider.set(provider, models);
      return { kind: 'loaded', models };
    } catch (error) {
      if (requestId !== this.#requestId) return { kind: 'stale', models: [] };
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
    this.#requestId++;
    this.#failedProviders.clear();
  }

  refresh(provider: string): void {
    this.invalidate(provider);
  }

  /** Invalidate provider state when its credential/readiness boundary changes. */
  invalidate(provider: string): void {
    this.#failedProviders.delete(provider);
    this.#modelsByProvider.delete(provider);
    ++this.#requestId;
    clearModelCache(provider);
  }

  nextProvider(current: string | null, direction: 'next' | 'prev'): string | undefined {
    const ids = getAvailableProviderIds(this.#settingsService, getProviderIds());
    const order = (this.#settingsService.getDynamic('providerOrder') as string[] | undefined) ?? [];
    const ordered = order.length > 0 ? sortProvidersByOrder(ids, order) : ids;
    if (ordered.length === 0) return undefined;
    const currentIndex = ordered.indexOf(current ?? '');
    if (currentIndex < 0) return direction === 'prev' ? ordered.at(-1) : ordered[0];
    const safeIndex = currentIndex;
    const offset = direction === 'prev' ? -1 : 1;
    return ordered[(safeIndex + offset + ordered.length) % ordered.length];
  }

  clear(): void {
    this.#requestId++;
    this.#modelsByProvider.clear();
    this.#failedProviders.clear();
  }
}
