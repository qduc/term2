/**
 * Token usage normalization and extraction utilities.
 * Ported from backend/src/lib/utils/usage.js
 */

export interface NormalizedUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    prompt_ms?: number;
    completion_ms?: number;
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
    );

    const cacheReadTokens = coalesceNumber(
        usage.cache_read_input_tokens,
        usage.cacheReadInputTokens,
    );

    const totalTokens =
        coalesceNumber(
            usage.total_tokens,
            usage.total_token_count,
            usage.totalTokenCount,
            usage.totalTokens, // Agents SDK
        ) ??
        sumNumbers(
            promptTokens,
            completionTokens,
            cacheCreationTokens,
            cacheReadTokens,
        );

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
    if (completionTokens != null)
        mapped.completion_tokens = completionTokens;
    if (totalTokens != null) mapped.total_tokens = totalTokens;
    if (reasoningTokens != null) mapped.reasoning_tokens = reasoningTokens;
    if (promptMs != null) mapped.prompt_ms = promptMs;
    if (completionMs != null) mapped.completion_ms = completionMs;

    return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function extractUsage(payload: any): NormalizedUsage | undefined {
    if (!payload || typeof payload !== 'object') return undefined;

    const results: NormalizedUsage[] = [];

    const direct = normalizeUsage(payload.usage);
    if (direct) results.push(direct);

    const metadata = normalizeUsage(
        payload.usageMetadata || payload.usage_metadata,
    );
    if (metadata) results.push(metadata);

    const nested = normalizeUsage(payload.response?.usage);
    if (nested) results.push(nested);

    const timings = normalizeUsage(payload.timings);
    if (timings) results.push(timings);

    // Fallback search for any usage field in the payload itself
    const self = normalizeUsage(payload);
    if (self) results.push(self);

    if (results.length === 0) return undefined;

    const merged: NormalizedUsage = {};
    for (let i = results.length - 1; i >= 0; i--) {
        Object.assign(merged, results[i]);
    }

    // Re-normalize to fix up computed total_tokens if components were merged from different sources
    return normalizeUsage(merged);
}

export function formatFooterUsage(usage: NormalizedUsage | null | undefined): string {
    if (!usage) return '';

    const parts: string[] = [];
    if (usage.prompt_tokens != null) {
        parts.push(`${usage.prompt_tokens.toLocaleString()} in`);
    }
    if (usage.completion_tokens != null) {
        parts.push(`${usage.completion_tokens.toLocaleString()} out`);
    }
    if (usage.total_tokens != null) {
        parts.push(`${usage.total_tokens.toLocaleString()} total`);
    }

    if (parts.length === 0) return '';
    return `Tok: ${parts.join(' / ')}`;
}
