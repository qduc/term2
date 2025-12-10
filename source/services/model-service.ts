import Fuse from 'fuse.js';
import {settingsService} from './settings-service.js';
import {loggingService} from './logging-service.js';

export type ModelInfo = {
    id: string;
    name?: string;
    provider: 'openai' | 'openrouter';
};

type FetchFn = (url: string, options?: any) => Promise<any>;

const cache = new Map<string, ModelInfo[]>();

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

function getOpenRouterBaseUrl(): string {
    return (
        settingsService.get<string>('agent.openrouter.baseUrl') ||
        'https://openrouter.ai/api/v1'
    );
}

function normalizeModelList(raw: any, provider: ModelInfo['provider']): ModelInfo[] {
    if (!Array.isArray(raw)) return [];

    return raw
        .map(item => {
            const id = item?.id || item?.model || '';
            const name = item?.name || item?.display_name || item?.description;
            return id
                ? {
                      id,
                      name,
                      provider,
                  }
                : null;
        })
        .filter(Boolean) as ModelInfo[];
}

async function fetchOpenAIModels(fetchImpl: FetchFn): Promise<ModelInfo[]> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchImpl(OPENAI_MODELS_URL, {headers});
    if (!response.ok) {
        throw new Error(`OpenAI models request failed (${response.status})`);
    }

    const body = await response.json();
    return normalizeModelList(body?.data, 'openai');
}

async function fetchOpenRouterModels(fetchImpl: FetchFn): Promise<ModelInfo[]> {
    const baseUrl = getOpenRouterBaseUrl();
    const apiKey = settingsService.get<string>('agent.openrouter.apiKey');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchImpl(`${baseUrl}/models`, {headers});
    if (!response.ok) {
        throw new Error(`OpenRouter models request failed (${response.status})`);
    }

    const body = await response.json();
    const filteredData = (body?.data || []).filter((item: any) =>
        Array.isArray(item?.supported_parameters) && item.supported_parameters.includes('tools')
    );
    return normalizeModelList(filteredData, 'openrouter');
}

export async function fetchModels(
    providerOverride?: 'openai' | 'openrouter',
    fetchImpl: FetchFn = fetch as any,
): Promise<ModelInfo[]> {
    const provider = providerOverride || settingsService.get<'openai' | 'openrouter'>('agent.provider');
    const cacheKey = provider;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey) as ModelInfo[];
    }

    try {
        const models =
            provider === 'openrouter'
                ? await fetchOpenRouterModels(fetchImpl)
                : await fetchOpenAIModels(fetchImpl);
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
