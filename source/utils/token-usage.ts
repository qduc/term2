/**
 * Token usage normalization and extraction utilities.
 * Ported from backend/src/lib/utils/usage.js
 */
export interface NormalizedUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  prompt_ms?: number;
  completion_ms?: number;
}

export interface UsageAccumulator {
  add(usage: NormalizedUsage | null | undefined): void;
  reset(): void;
  get(): NormalizedUsage;
}

function toNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return undefined;
  return asNumber;
}

function coalesceNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const num = toNumber(value);
    if (num != null) return num;
  }
  return undefined;
}

function sumNumbers(...values: unknown[]): number | undefined {
  let total = 0;
  let found = false;
  for (const value of values) {
    const num = toNumber(value);
    if (num == null) continue;
    total += num;
    found = true;
  }
  return found ? total : undefined;
}

function asUsageContainer(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, any>;
}

export function normalizeUsage(usage: any): NormalizedUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;

  const promptTokens = coalesceNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.input_token_count,
    usage.prompt_token_count,
    usage.promptTokenCount,
    usage.inputTokenCount,
    usage.inputTokens, // Agents SDK
    usage.prompt_n !== undefined && usage.prompt_n != null
      ? (toNumber(usage.cache_n) || 0) + toNumber(usage.prompt_n)!
      : undefined,
  );

  const completionTokens = coalesceNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.output_token_count,
    usage.completion_token_count,
    usage.candidatesTokenCount,
    usage.outputTokenCount,
    usage.outputTokens, // Agents SDK
    usage.predicted_n,
  );

  const cacheCreationTokens = coalesceNumber(
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
    usage.cache_creation_tokens,
    usage.cacheCreationTokens,
  );

  const cacheReadTokens = coalesceNumber(
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cache_read_tokens,
    usage.cached_tokens,
    usage.cachedTokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.promptTokensDetails?.cachedTokens,
    usage.cachedContentTokenCount,
    usage.cached_content_token_count,
  );

  const totalTokens =
    coalesceNumber(
      usage.total_tokens,
      usage.total_token_count,
      usage.totalTokenCount,
      usage.totalTokens, // Agents SDK
    ) ?? sumNumbers(promptTokens, completionTokens, cacheCreationTokens);

  const reasoningTokens = coalesceNumber(
    usage.reasoning_tokens,
    usage.reasoning_token_count,
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.output_tokens_details?.reasoning_tokens,
    usage.thoughtsTokenCount,
    usage.thoughts_token_count,
  );

  const promptMs = coalesceNumber(usage.prompt_ms, usage.promptMs);

  const completionMs = coalesceNumber(
    usage.completion_ms,
    usage.completionMs,
    usage.predicted_ms,
    usage.predictedMs,
    usage.output_ms,
    usage.outputMs,
  );

  const mapped: NormalizedUsage = {};
  if (promptTokens != null) mapped.prompt_tokens = promptTokens;
  if (completionTokens != null) mapped.completion_tokens = completionTokens;
  if (totalTokens != null) mapped.total_tokens = totalTokens;
  if (reasoningTokens != null) mapped.reasoning_tokens = reasoningTokens;
  if (cacheReadTokens != null) mapped.cache_read_tokens = cacheReadTokens;
  if (cacheCreationTokens != null) mapped.cache_creation_tokens = cacheCreationTokens;
  if (promptMs != null) mapped.prompt_ms = promptMs;
  if (completionMs != null) mapped.completion_ms = completionMs;

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function extractUsage(payload: unknown): NormalizedUsage | undefined {
  const root = asUsageContainer(payload);
  if (!root) return undefined;

  const results: NormalizedUsage[] = [];
  const seen = new Set<Record<string, any>>();
  const enqueue = (candidate: unknown) => {
    const record = asUsageContainer(candidate);
    if (!record || seen.has(record)) return;
    seen.add(record);

    const direct = normalizeUsage(record.usage);
    if (direct) results.push(direct);

    const metadata = normalizeUsage(record.usageMetadata || record.usage_metadata);
    if (metadata) results.push(metadata);

    const responseUsage = normalizeUsage(asUsageContainer(record.response)?.usage);
    if (responseUsage) results.push(responseUsage);

    const eventUsage = normalizeUsage(asUsageContainer(record.event)?.usage);
    if (eventUsage) results.push(eventUsage);

    const timings = normalizeUsage(record.timings);
    if (timings) results.push(timings);

    const self = normalizeUsage(record);
    if (self) results.push(self);
  };

  enqueue(root);
  enqueue(root.data);
  enqueue(root.event);
  enqueue(asUsageContainer(root.data)?.event);
  enqueue(root.response);
  enqueue(asUsageContainer(root.data)?.response);

  if (results.length === 0) return undefined;

  const merged: NormalizedUsage = {};
  for (let i = results.length - 1; i >= 0; i--) {
    Object.assign(merged, results[i]);
  }

  const mergedComponentTotal = sumNumbers(merged.prompt_tokens, merged.completion_tokens, merged.cache_creation_tokens);
  if (mergedComponentTotal != null) {
    merged.total_tokens = mergedComponentTotal;
  }

  // Re-normalize to fix up computed total_tokens if components were merged from different sources
  return normalizeUsage(merged);
}

export function mergeUsage(
  preferred: NormalizedUsage | undefined,
  fallback: NormalizedUsage | undefined,
): NormalizedUsage | undefined {
  if (!preferred) return fallback;
  if (!fallback) return preferred;

  const merged = { ...fallback, ...preferred };
  return normalizeUsage(merged) ?? merged;
}

export function formatFooterUsage(usage: NormalizedUsage | null | undefined): string {
  if (!usage) return '';

  const parts: string[] = [];
  if (usage.prompt_tokens != null) {
    let promptPart = `${usage.prompt_tokens.toLocaleString()} in`;
    const promptDetails: string[] = [];
    if (usage.cache_read_tokens != null) {
      promptDetails.push(`${usage.cache_read_tokens.toLocaleString()} cached`);
    }
    if (usage.cache_creation_tokens != null) {
      promptDetails.push(`${usage.cache_creation_tokens.toLocaleString()} cache write`);
    }
    if (promptDetails.length > 0) {
      promptPart += ` (${promptDetails.join(', ')})`;
    }
    parts.push(promptPart);
  }
  if (usage.completion_tokens != null) {
    parts.push(`${usage.completion_tokens.toLocaleString()} out`);
  }

  if (parts.length === 0) return '';
  return `Tok: ${parts.join(' / ')}`;
}

export function addTokenUsage(
  current: NormalizedUsage | null | undefined,
  next: NormalizedUsage | null | undefined,
): NormalizedUsage {
  const result: NormalizedUsage = { ...(current ?? {}) };
  if (!next) return result;

  const addField = (field: keyof NormalizedUsage) => {
    const value = next[field];
    if (value == null) return;
    result[field] = (result[field] ?? 0) + value;
  };

  addField('prompt_tokens');
  addField('completion_tokens');
  addField('total_tokens');
  addField('reasoning_tokens');
  addField('cache_read_tokens');
  addField('cache_creation_tokens');
  addField('prompt_ms');
  addField('completion_ms');

  return result;
}

export function createUsageAccumulator(initialUsage?: NormalizedUsage | null): UsageAccumulator {
  let accumulated = addTokenUsage(undefined, initialUsage);

  return {
    add(usage) {
      accumulated = addTokenUsage(accumulated, usage);
    },
    reset() {
      accumulated = {};
    },
    get() {
      return { ...accumulated };
    },
  };
}

export function formatSessionTokenUsage(usage: NormalizedUsage | null | undefined): string {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const cachedTokens = usage?.cache_read_tokens ?? 0;

  const cachedPart = cachedTokens > 0 ? ` (${cachedTokens.toLocaleString()} cached)` : '';
  return `Token usage: ${promptTokens.toLocaleString()} input${cachedPart}, ${completionTokens.toLocaleString()} output`;
}
