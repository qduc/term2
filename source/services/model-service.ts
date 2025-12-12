import Fuse from 'fuse.js';
import {settingsService} from './settings-service.js';
import {loggingService} from './logging-service.js';
import {getProvider} from '../providers/index.js';

export type ModelInfo = {
    id: string;
    name?: string;
    provider: string;
};

type FetchFn = (url: string, options?: any) => Promise<any>;

const cache = new Map<string, ModelInfo[]>();

export async function fetchModels(
    providerOverride?: string,
    fetchImpl: FetchFn = fetch as any,
): Promise<ModelInfo[]> {
    const provider = providerOverride || settingsService.get<string>('agent.provider');
    const cacheKey = provider;

    if (cache.has(cacheKey)) {
        return cache.get(cacheKey) as ModelInfo[];
    }

    try {
        const providerDef = getProvider(provider);
        if (!providerDef) {
            throw new Error(`Provider '${provider}' is not registered`);
        }

        const rawModels = await providerDef.fetchModels(fetchImpl);
        const models: ModelInfo[] = rawModels.map(m => ({
            ...m,
            provider,
        }));

        cache.set(cacheKey, models);
        return models;
    } catch (error) {
        loggingService.warn('Failed to fetch models', {
            provider,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

export function clearModelCache(): void {
    cache.clear();
}

export function filterModels(
    models: ModelInfo[],
    query: string,
): ModelInfo[] {
    if (!query.trim()) {
        return models;
    }

    const fuse = new Fuse(models, {
        keys: ['id', 'name'],
        threshold: 0.4,
        ignoreLocation: true,
    });

    return fuse
        .search(query.trim())
        .map(match => match.item);
}
