import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
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

export type DiskModelCacheEntry = {
  version: 1;
  provider: string;
  timestamp: number;
  models: ModelInfo[];
};

export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export type FetchModelsDeps = {
  settingsService: ISettingsService;
  loggingService: ILoggingService;
  signal?: AbortSignal;
  cacheDir?: string;
  now?: () => number;
  ttlMs?: number;
};

type FetchFn = typeof fetch;

const cache = new Map<string, ModelInfo[]>();

let testCacheDir: string | null = null;
let testClock: (() => number) | null = null;

export function setModelCacheDirForTest(dir: string | null): void {
  testCacheDir = dir;
}

export function setModelCacheClockForTest(clock: (() => number) | null): void {
  testClock = clock;
}

export function clearModelMemoryCacheForTest(): void {
  cache.clear();
}

export function getModelCacheDir(customDir?: string): string {
  const baseDir = customDir || testCacheDir || process.env.TERM2_CACHE_DIR || envPaths('term2').cache;
  return path.join(baseDir, 'models');
}

export function getModelCacheFilePath(provider: string, customDir?: string): string {
  const safeName = provider.replace(/[^a-zA-Z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
  return path.join(getModelCacheDir(customDir), `${safeName}.json`);
}

function readDiskCache(
  provider: string,
  cacheDir?: string,
  nowFn?: () => number,
  ttlMs: number = MODEL_CACHE_TTL_MS,
  loggingService?: ILoggingService,
): ModelInfo[] | null {
  try {
    const filePath = getModelCacheFilePath(provider, cacheDir);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (parsed.version !== 1) {
      return null;
    }
    if (typeof parsed.timestamp !== 'number' || !Number.isFinite(parsed.timestamp)) {
      return null;
    }
    const now = nowFn ?? testClock ?? Date.now;
    const currentTime = now();
    const age = currentTime - parsed.timestamp;
    if (age < 0 || age >= ttlMs) {
      return null;
    }
    if (!Array.isArray(parsed.models)) {
      return null;
    }
    for (const m of parsed.models) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string') {
        return null;
      }
    }
    return parsed.models as ModelInfo[];
  } catch (error) {
    loggingService?.debug?.('Failed to read model disk cache', { provider, error: String(error) });
    return null;
  }
}

function writeDiskCache(
  provider: string,
  models: ModelInfo[],
  cacheDir?: string,
  nowFn?: () => number,
  loggingService?: ILoggingService,
): void {
  const dir = getModelCacheDir(cacheDir);
  const targetFile = getModelCacheFilePath(provider, cacheDir);
  const baseName = path.basename(targetFile, '.json');
  const tempFile = path.join(
    dir,
    `.${baseName}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let tempCreated = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const now = nowFn ?? testClock ?? Date.now;
    const payload: DiskModelCacheEntry = {
      version: 1,
      provider,
      timestamp: now(),
      models,
    };
    const content = JSON.stringify(payload);
    const fd = fs.openSync(tempFile, 'wx');
    tempCreated = true;
    try {
      fs.writeFileSync(fd, content, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFile, targetFile);
    tempCreated = false;
  } catch (error) {
    loggingService?.warn('Failed to write model disk cache', { provider, error: String(error) });
  } finally {
    if (tempCreated) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Best-effort cleanup of temp file
      }
    }
  }
}

export async function fetchModels(
  deps: FetchModelsDeps,
  providerOverride?: string,
  fetchImpl: FetchFn = fetch,
): Promise<ModelInfo[]> {
  const { settingsService, loggingService } = deps;
  const provider = providerOverride || settingsService.get('agent.provider');
  const cacheKey = provider;

  // 1. In-memory cache hit
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) as ModelInfo[];
  }

  // 2. Disk cache hit
  const diskCached = readDiskCache(provider, deps.cacheDir, deps.now, deps.ttlMs, loggingService);
  if (diskCached) {
    cache.set(cacheKey, diskCached);
    return diskCached;
  }

  // 3. Cache miss: fetch from provider
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
    writeDiskCache(provider, models, deps.cacheDir, deps.now, loggingService);
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

export function clearModelCache(provider?: string, opts?: { cacheDir?: string }): void {
  if (provider) {
    cache.delete(provider);
  } else {
    cache.clear();
  }

  try {
    const dir = getModelCacheDir(opts?.cacheDir);
    if (provider) {
      const targetFile = getModelCacheFilePath(provider, opts?.cacheDir);
      if (fs.existsSync(targetFile)) {
        try {
          fs.unlinkSync(targetFile);
        } catch {
          // ignore
        }
      }
    } else {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.json') || file.endsWith('.tmp')) {
            try {
              fs.unlinkSync(path.join(dir, file));
            } catch {
              // ignore
            }
          }
        }
      }
    }
  } catch {
    // Disk cache clearing is best-effort and must not throw
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
