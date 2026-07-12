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
  add(usage: NormalizedUsage | null | undefined, options?: { alreadyBillable?: boolean }): void;
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
    usage.cacheWrite5mTokens,
    usage.cacheWrite1hTokens,
  );

  const cacheReadTokens = coalesceNumber(
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cache_read_tokens,
    usage.cached_tokens,
    usage.cachedTokens,
    usage.inputTokensDetails?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.promptTokensDetails?.cachedTokens,
    usage.cachedContentTokenCount,
    usage.cached_content_token_count,
    usage.cacheReadTokens,
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
    usage.reasoningTokens,
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

    const normalized = normalizeUsage(record.normalizedUsage);
    if (normalized) results.push(normalized);

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

function sumDetailField(details: unknown, keys: string[]): number | undefined {
  if (!Array.isArray(details)) {
    // The SDK may surface a single detail record instead of a per-request array.
    const single = asUsageContainer(details);
    if (!single) return undefined;
    return coalesceNumber(...keys.map((key) => single[key]));
  }

  let total = 0;
  let found = false;
  for (const entry of details) {
    const record = asUsageContainer(entry);
    if (!record) continue;
    const value = coalesceNumber(...keys.map((key) => record[key]));
    if (value == null) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

/**
 * Normalize the Agents SDK run-level Usage accumulator (`runState.usage`) into
 * NormalizedUsage. This is the authoritative, already-cumulative usage for an
 * entire run (all model turns, including resumed approval continuations, since
 * the SDK keeps accumulating onto the same RunContext.usage). Cache and
 * reasoning details are exposed as per-request arrays, so they are summed here.
 */
export function normalizeAgentRunUsage(stateUsage: any): NormalizedUsage | undefined {
  const usage = asUsageContainer(stateUsage);
  if (!usage) return undefined;

  const promptTokens = coalesceNumber(usage.inputTokens, usage.input_tokens);
  const completionTokens = coalesceNumber(usage.outputTokens, usage.output_tokens);
  const totalTokens =
    coalesceNumber(usage.totalTokens, usage.total_tokens) ?? sumNumbers(promptTokens, completionTokens);

  const cacheReadTokens = sumDetailField(usage.inputTokensDetails ?? usage.input_tokens_details, [
    'cached_tokens',
    'cachedTokens',
    'cache_read_tokens',
    'cacheReadTokens',
  ]);
  const cacheCreationTokens = sumDetailField(usage.inputTokensDetails ?? usage.input_tokens_details, [
    'cache_creation_tokens',
    'cacheCreationTokens',
    'cache_creation_input_tokens',
  ]);
  const reasoningTokens = sumDetailField(usage.outputTokensDetails ?? usage.output_tokens_details, [
    'reasoning_tokens',
    'reasoningTokens',
  ]);

  const mapped: NormalizedUsage = {};
  if (promptTokens != null) mapped.prompt_tokens = promptTokens;
  if (completionTokens != null) mapped.completion_tokens = completionTokens;
  if (totalTokens != null) mapped.total_tokens = totalTokens;
  if (reasoningTokens != null) mapped.reasoning_tokens = reasoningTokens;
  if (cacheReadTokens != null) mapped.cache_read_tokens = cacheReadTokens;
  if (cacheCreationTokens != null) mapped.cache_creation_tokens = cacheCreationTokens;

  // An all-zero accumulator means the provider never reported usage; treat as absent
  // so callers can fall back to other extraction paths.
  const hasSignal = (mapped.prompt_tokens ?? 0) + (mapped.completion_tokens ?? 0) + (mapped.total_tokens ?? 0) > 0;
  return hasSignal ? mapped : undefined;
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

export function formatFooterUsage(
  usage: NormalizedUsage | null | undefined,
  options: { cacheWarning?: boolean } = {},
): string {
  if (!usage) return '';

  const parts: string[] = [];
  if (usage.prompt_tokens != null) {
    let promptPart = `${usage.prompt_tokens.toLocaleString()} in`;
    const promptDetails: string[] = [];
    if (usage.cache_read_tokens != null) {
      const cacheLabel = options.cacheWarning ? 'uncached' : 'cached';
      const cachePrefix = options.cacheWarning ? '⚠️ ' : '';
      promptDetails.push(`${cachePrefix}${usage.cache_read_tokens.toLocaleString()} ${cacheLabel}`);
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

export function addBillableSessionTokenUsage(
  current: NormalizedUsage | null | undefined,
  next: NormalizedUsage | null | undefined,
): NormalizedUsage {
  if (!next) return { ...(current ?? {}) };

  const billablePromptTokens =
    next.prompt_tokens == null ? undefined : Math.max(0, next.prompt_tokens - (next.cache_read_tokens ?? 0));

  return addTokenUsage(current, {
    ...next,
    ...(billablePromptTokens != null ? { prompt_tokens: billablePromptTokens } : {}),
  });
}

export function createUsageAccumulator(initialUsage?: NormalizedUsage | null): UsageAccumulator {
  let accumulated = addBillableSessionTokenUsage(undefined, initialUsage);

  return {
    add(usage, options) {
      if (options?.alreadyBillable) {
        accumulated = addTokenUsage(accumulated, usage);
      } else {
        accumulated = addBillableSessionTokenUsage(accumulated, usage);
      }
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

function formatUsageLine(label: string, usage: NormalizedUsage | null | undefined): string {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const cachedTokens = usage?.cache_read_tokens ?? 0;

  const cachedPart = cachedTokens > 0 ? ` (${cachedTokens.toLocaleString()} cached)` : '';
  return `${label}: ${promptTokens.toLocaleString()} input${cachedPart}, ${completionTokens.toLocaleString()} output`;
}

/**
 * Format session usage with a breakdown of main vs subagent token usage.
 * Falls back to the legacy single-line format when there is no subagent usage.
 */
export function formatSessionUsageBreakdown(
  main: NormalizedUsage | null | undefined,
  sub: NormalizedUsage | null | undefined,
): string {
  const hasSubUsage = sub && Object.keys(sub).length > 0 && (sub.prompt_tokens ?? 0) + (sub.completion_tokens ?? 0) > 0;

  if (!hasSubUsage) {
    return formatSessionTokenUsage(main);
  }

  const mainLine = formatUsageLine('Main', main);
  const subLine = formatUsageLine('Subagents', sub);
  const total = addTokenUsage(main, sub);
  const totalLine = formatUsageLine('Total', total);

  return `${mainLine}\n${subLine}\n${totalLine}`;
}
