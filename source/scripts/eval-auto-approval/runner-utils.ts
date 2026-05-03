import { readFileSync } from 'node:fs';
import { dirname, extname, join, basename } from 'node:path';
import YAML from 'yaml';

export const EVAL_CACHE_VERSION = 'auto-approval-evaluator-v2';

export interface ModelRunConfig {
  provider: string;
  model: string;
}

type SleepImpl = (ms: number) => Promise<void>;

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getNestedErrorRecord(error: unknown): Record<string, unknown> | undefined {
  const record = asRecord(error);
  const nestedError = asRecord(record?.error);
  return nestedError;
}

function getErrorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const nestedError = getNestedErrorRecord(error);

  const candidates = [record?.status, record?.code, nestedError?.status, nestedError?.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string') {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const headerRecord = asRecord(headers);
  if (!headerRecord) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headerRecord)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

function getErrorHeaders(error: unknown): Record<string, string> {
  const record = asRecord(error);
  const nestedError = getNestedErrorRecord(error);
  const metadata = asRecord(nestedError?.metadata);

  return {
    ...normalizeHeaders(metadata?.headers),
    ...normalizeHeaders(nestedError?.headers),
    ...normalizeHeaders(record?.headers),
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const record = asRecord(error);
  const nestedError = getNestedErrorRecord(error);

  if (typeof nestedError?.message === 'string') {
    return nestedError.message;
  }

  if (typeof record?.message === 'string') {
    return record.message;
  }

  return String(error);
}

function parseRetryAfterMs(value: string | undefined, now: () => number): number | undefined {
  if (!value) {
    return undefined;
  }

  const asInteger = Number.parseInt(value, 10);
  if (Number.isFinite(asInteger)) {
    return Math.max(0, asInteger) * 1000;
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - now());
  }

  return undefined;
}

function parseRateLimitResetMs(value: string | undefined, now: () => number): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  const resetAtMs = parsed >= 1_000_000_000_000 ? parsed : parsed * 1000;
  return Math.max(0, resetAtMs - now());
}

function computeBackoffDelayMs(attemptIndex: number, maxDelayMs: number): number {
  const exponentialDelay = 1000 * Math.pow(2, attemptIndex);
  return Math.min(exponentialDelay, maxDelayMs);
}

export function isRateLimitError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 429) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return message.includes('rate limit') || message.includes('too many requests');
}

export function getRateLimitRetryDelayMs(
  error: unknown,
  {
    attemptIndex,
    now = Date.now,
    maxDelayMs = 30_000,
  }: {
    attemptIndex: number;
    now?: () => number;
    maxDelayMs?: number;
  },
): number {
  const headers = getErrorHeaders(error);

  return (
    parseRetryAfterMs(headers['retry-after'], now) ??
    parseRateLimitResetMs(headers['x-ratelimit-reset'], now) ??
    computeBackoffDelayMs(attemptIndex, maxDelayMs)
  );
}

export async function retryOnRateLimit<T>({
  operation,
  maxRetries = 2,
  maxDelayMs = 30_000,
  sleep = defaultSleep,
  now = Date.now,
  onRetry,
}: {
  operation: () => Promise<T>;
  maxRetries?: number;
  maxDelayMs?: number;
  sleep?: SleepImpl;
  now?: () => number;
  onRetry?: (details: { attempt: number; retriesRemaining: number; delayMs: number; error: unknown }) => void;
}): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }

      const delayMs = getRateLimitRetryDelayMs(error, {
        attemptIndex: attempt,
        now,
        maxDelayMs,
      });

      onRetry?.({
        attempt: attempt + 1,
        retriesRemaining: maxRetries - attempt - 1,
        delayMs,
        error,
      });

      await sleep(delayMs);
      attempt++;
    }
  }
}

export function getReportPath(outputPath: string): string {
  const extension = extname(outputPath);
  if (extension === '.json') {
    return outputPath.slice(0, -extension.length) + '.md';
  }

  return join(dirname(outputPath), `${basename(outputPath)}.md`);
}

export function validateRunnerOptions({ concurrency, repeat }: { concurrency: number; repeat: number }): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('--concurrency must be an integer greater than or equal to 1');
  }

  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error('--repeat must be an integer greater than or equal to 1');
  }
}

function assertModelRunList(provider: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`Provider "${provider}" must map to a list of models`);
  }
}

export function parseModelRunsYaml(rawYaml: string): ModelRunConfig[] {
  const parsed = YAML.parse(rawYaml);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Model run YAML must be a mapping of provider names to model lists');
  }

  const runs: ModelRunConfig[] = [];
  for (const [provider, models] of Object.entries(parsed as Record<string, unknown>)) {
    assertModelRunList(provider, models);
    for (const model of models) {
      runs.push({ provider, model });
    }
  }

  return runs;
}

export function loadModelRunsFromYaml(path: string): ModelRunConfig[] {
  return parseModelRunsYaml(readFileSync(path, 'utf-8'));
}

export function createCacheKey({
  model,
  provider,
  promptVersion,
  command,
  history,
}: {
  model: string;
  provider: string;
  promptVersion: string;
  command: string;
  history: unknown;
}): Record<string, unknown> {
  return {
    version: EVAL_CACHE_VERSION,
    model,
    provider,
    promptVersion,
    command,
    history,
  };
}
