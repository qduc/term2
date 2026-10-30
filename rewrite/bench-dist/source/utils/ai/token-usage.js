function toNumber(value) {
    if (value == null)
        return undefined;
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber))
        return undefined;
    return asNumber;
}
function coalesceNumber(...values) {
    for (const value of values) {
        const num = toNumber(value);
        if (num != null)
            return num;
    }
    return undefined;
}
function sumNumbers(...values) {
    let total = 0;
    let found = false;
    for (const value of values) {
        const num = toNumber(value);
        if (num == null)
            continue;
        total += num;
        found = true;
    }
    return found ? total : undefined;
}
function asUsageContainer(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    return value;
}
export function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object')
        return undefined;
    const promptTokens = coalesceNumber(usage.prompt_tokens, usage.input_tokens, usage.input_token_count, usage.prompt_token_count, usage.promptTokenCount, usage.inputTokenCount, usage.inputTokens, usage.prompt_n !== undefined && usage.prompt_n != null
        ? (toNumber(usage.cache_n) || 0) + toNumber(usage.prompt_n)
        : undefined);
    const completionTokens = coalesceNumber(usage.completion_tokens, usage.output_tokens, usage.output_token_count, usage.completion_token_count, usage.candidatesTokenCount, usage.outputTokenCount, usage.outputTokens?.total ?? usage.outputTokens, usage.predicted_n);
    const cacheCreationTokens = coalesceNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens, usage.cache_creation_tokens, usage.cacheCreationTokens, usage.cache_write_tokens, usage.cacheWriteTokens, sumDetailField(usage.inputTokensDetails ?? usage.input_tokens_details, ['cache_write_tokens', 'cacheWriteTokens']), usage.cacheWrite5mTokens, usage.cacheWrite1hTokens);
    const cacheReadTokens = coalesceNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens, usage.cache_read_tokens, usage.cached_tokens, usage.cachedTokens, usage.cachedInputTokens, usage.cached_input_tokens, usage.inputTokensDetails?.cached_tokens, usage.prompt_tokens_details?.cached_tokens, usage.promptTokensDetails?.cachedTokens, usage.cachedContentTokenCount, usage.cached_content_token_count, usage.cacheReadTokens);
    const totalTokens = coalesceNumber(usage.total_tokens, usage.total_token_count, usage.totalTokenCount, usage.totalTokens) ??
        sumNumbers(promptTokens, completionTokens, cacheCreationTokens);
    const reasoningTokens = coalesceNumber(usage.reasoning_tokens, usage.reasoning_token_count, usage?.completion_tokens_details?.reasoning_tokens, usage?.output_tokens_details?.reasoning_tokens, usage?.outputTokensDetails?.reasoning_tokens, usage?.outputTokensDetails?.reasoningTokens, usage?.outputTokens?.reasoning, usage.thoughtsTokenCount, usage.thoughts_token_count, usage.reasoningTokens);
    const promptMs = coalesceNumber(usage.prompt_ms, usage.promptMs);
    const completionMs = coalesceNumber(usage.completion_ms, usage.completionMs, usage.predicted_ms, usage.predictedMs, usage.output_ms, usage.outputMs);
    const tokensPerSecond = coalesceNumber(usage.tokens_per_second, usage.tokensPerSecond, usage.tps);
    const tokensPerSecondEstimated = usage.tokens_per_second_estimated === true || usage.tokensPerSecondEstimated === true;
    const ttftMs = coalesceNumber(usage.ttft_ms, usage.ttftMs);
    const upstreamProvider = typeof usage.upstream_provider === 'string' && usage.upstream_provider.trim().length > 0
        ? usage.upstream_provider.trim()
        : typeof usage.upstreamProvider === 'string' && usage.upstreamProvider.trim().length > 0
            ? usage.upstreamProvider.trim()
            : undefined;
    const mapped = {};
    if (promptTokens != null)
        mapped.prompt_tokens = promptTokens;
    if (completionTokens != null)
        mapped.completion_tokens = completionTokens;
    if (totalTokens != null)
        mapped.total_tokens = totalTokens;
    if (reasoningTokens != null)
        mapped.reasoning_tokens = reasoningTokens;
    if (cacheReadTokens != null)
        mapped.cache_read_tokens = cacheReadTokens;
    if (cacheCreationTokens != null)
        mapped.cache_creation_tokens = cacheCreationTokens;
    if (promptMs != null)
        mapped.prompt_ms = promptMs;
    if (completionMs != null)
        mapped.completion_ms = completionMs;
    if (tokensPerSecond != null)
        mapped.tokens_per_second = tokensPerSecond;
    if (tokensPerSecondEstimated)
        mapped.tokens_per_second_estimated = true;
    if (ttftMs != null)
        mapped.ttft_ms = ttftMs;
    if (upstreamProvider != null)
        mapped.upstream_provider = upstreamProvider;
    return Object.keys(mapped).length > 0 ? mapped : undefined;
}
export function extractUsage(payload) {
    const root = asUsageContainer(payload);
    if (!root)
        return undefined;
    const results = [];
    const seen = new Set();
    const enqueue = (candidate) => {
        const record = asUsageContainer(candidate);
        if (!record || seen.has(record))
            return;
        seen.add(record);
        const direct = normalizeUsage(record.usage);
        if (direct)
            results.push(direct);
        const metadata = normalizeUsage(record.usageMetadata || record.usage_metadata);
        if (metadata)
            results.push(metadata);
        const normalized = normalizeUsage(record.normalizedUsage);
        if (normalized)
            results.push(normalized);
        const responseUsage = normalizeUsage(asUsageContainer(record.response)?.usage);
        if (responseUsage)
            results.push(responseUsage);
        const eventUsage = normalizeUsage(asUsageContainer(record.event)?.usage);
        if (eventUsage)
            results.push(eventUsage);
        const timings = normalizeUsage(record.timings);
        if (timings)
            results.push(timings);
        const self = normalizeUsage(record);
        if (self)
            results.push(self);
        const providerMetadata = asUsageContainer(record.providerMetadata);
        // SDK metadata is namespaced by adapter; normalize the same wire fields
        // for every namespace instead of recognizing one vendor here.
        const metadataRecords = [providerMetadata, ...Object.values(providerMetadata ?? {}).map(asUsageContainer)];
        for (const metadataRecord of metadataRecords) {
            const upstreamProvider = metadataRecord?.provider ?? metadataRecord?.provider_name;
            if (typeof upstreamProvider === 'string' && upstreamProvider.trim().length > 0) {
                results.push({ upstream_provider: upstreamProvider.trim() });
                break;
            }
        }
    };
    enqueue(root);
    enqueue(root.data);
    enqueue(root.event);
    enqueue(asUsageContainer(root.data)?.event);
    enqueue(root.response);
    enqueue(asUsageContainer(root.data)?.response);
    if (results.length === 0)
        return undefined;
    const merged = {};
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
function sumDetailField(details, keys) {
    if (!Array.isArray(details)) {
        // The SDK may surface a single detail record instead of a per-request array.
        const single = asUsageContainer(details);
        if (!single)
            return undefined;
        return coalesceNumber(...keys.map((key) => single[key]));
    }
    let total = 0;
    let found = false;
    for (const entry of details) {
        const record = asUsageContainer(entry);
        if (!record)
            continue;
        const value = coalesceNumber(...keys.map((key) => record[key]));
        if (value == null)
            continue;
        total += value;
        found = true;
    }
    return found ? total : undefined;
}
/**
 * Normalize the application run-level usage accumulator (`runState.usage`)
 * into NormalizedUsage. This is the authoritative, already-cumulative usage
 * for an entire run (all model turns, including resumed approval
 * continuations). Cache and reasoning details are exposed as per-request
 * arrays, so they are summed here.
 */
export function normalizeAgentRunUsage(stateUsage) {
    const usage = asUsageContainer(stateUsage);
    if (!usage)
        return undefined;
    const promptTokens = coalesceNumber(usage.inputTokens, usage.input_tokens);
    const completionTokens = coalesceNumber(usage.outputTokens, usage.output_tokens);
    // Application-owned run state stores these as cumulative scalar totals. Prefer
    // them when present; detail arrays are the legacy SDK fallback and must not be
    // added a second time when both representations coexist.
    const cacheReadTokens = coalesceNumber(usage.cachedInputTokens, usage.cached_input_tokens, usage.cacheReadTokens) ??
        sumDetailField(usage.inputTokensDetails ?? usage.input_tokens_details, [
            'cached_tokens',
            'cachedTokens',
            'cache_read_tokens',
            'cacheReadTokens',
        ]);
    const cacheCreationTokens = coalesceNumber(usage.cacheWriteTokens, usage.cache_write_tokens, usage.cacheCreationTokens) ??
        sumDetailField(usage.inputTokensDetails ?? usage.input_tokens_details, [
            'cache_creation_tokens',
            'cacheCreationTokens',
            'cache_creation_input_tokens',
            'cache_write_tokens',
            'cacheWriteTokens',
        ]);
    const reasoningTokens = sumDetailField(usage.outputTokensDetails ?? usage.output_tokens_details, [
        'reasoning_tokens',
        'reasoningTokens',
    ]);
    // Match normalizeUsage(): cache creation represents billable input and is
    // included in the total whenever a provider did not supply a native total.
    const totalTokens = coalesceNumber(usage.totalTokens, usage.total_tokens) ??
        sumNumbers(promptTokens, completionTokens, cacheCreationTokens);
    const mapped = {};
    if (promptTokens != null)
        mapped.prompt_tokens = promptTokens;
    if (completionTokens != null)
        mapped.completion_tokens = completionTokens;
    if (totalTokens != null)
        mapped.total_tokens = totalTokens;
    if (reasoningTokens != null)
        mapped.reasoning_tokens = reasoningTokens;
    if (cacheReadTokens != null)
        mapped.cache_read_tokens = cacheReadTokens;
    if (cacheCreationTokens != null)
        mapped.cache_creation_tokens = cacheCreationTokens;
    // An all-zero accumulator means the provider never reported usage; treat as absent
    // so callers can fall back to other extraction paths.
    const hasSignal = (mapped.prompt_tokens ?? 0) + (mapped.completion_tokens ?? 0) + (mapped.total_tokens ?? 0) > 0;
    return hasSignal ? mapped : undefined;
}
export function mergeUsage(preferred, fallback) {
    if (!preferred)
        return fallback;
    if (!fallback)
        return preferred;
    const merged = { ...fallback, ...preferred };
    return normalizeUsage(merged) ?? merged;
}
export function formatFooterUsage(usage, options = {}) {
    if (!usage)
        return '';
    const parts = [];
    if (usage.prompt_tokens != null) {
        let promptPart = `${usage.prompt_tokens.toLocaleString()} in`;
        const promptDetails = [];
        if (usage.cache_read_tokens != null) {
            const cacheLabel = options.cacheWarning ? 'uncached' : 'cached';
            const cachePrefix = options.cacheWarning ? '⚠️ ' : '';
            promptDetails.push(`${cachePrefix}${usage.cache_read_tokens.toLocaleString()} ${cacheLabel}`);
        }
        if (promptDetails.length > 0) {
            promptPart += ` (${promptDetails.join(', ')})`;
        }
        parts.push(promptPart);
    }
    if (usage.completion_tokens != null) {
        parts.push(`${usage.completion_tokens.toLocaleString()} out`);
    }
    if (parts.length === 0)
        return '';
    return `Tok: ${parts.join(' / ')}`;
}
function formatCompactTokens(tokens) {
    return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1_000)}k`;
}
/**
 * Compact context gauge, e.g. "100k/1.0M": tokens used in the current context
 * (the last request's prompt tokens) over the model's context window.
 * When the context window is unknown, returns only the used token gauge (e.g. "100k").
 */
export function formatContextUsage(usedTokens, contextWindow) {
    if (contextWindow == null) {
        return formatCompactTokens(usedTokens);
    }
    return `${formatCompactTokens(usedTokens)}/${formatCompactTokens(contextWindow)}`;
}
export function addTokenUsage(current, next) {
    const result = { ...(current ?? {}) };
    if (!next)
        return result;
    const addField = (field) => {
        const value = next[field];
        if (value == null)
            return;
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
    if (next.tokens_per_second != null) {
        result.tokens_per_second = next.tokens_per_second;
        if (next.tokens_per_second_estimated)
            result.tokens_per_second_estimated = true;
        else
            delete result.tokens_per_second_estimated;
        if (next.tokens_per_second_burst)
            result.tokens_per_second_burst = true;
        else
            delete result.tokens_per_second_burst;
    }
    if (next.ttft_ms != null)
        result.ttft_ms = next.ttft_ms;
    if (next.upstream_provider != null)
        result.upstream_provider = next.upstream_provider;
    return result;
}
export function addBillableSessionTokenUsage(current, next) {
    if (!next)
        return { ...(current ?? {}) };
    const billablePromptTokens = next.prompt_tokens == null ? undefined : Math.max(0, next.prompt_tokens - (next.cache_read_tokens ?? 0));
    return addTokenUsage(current, {
        ...next,
        ...(billablePromptTokens != null ? { prompt_tokens: billablePromptTokens } : {}),
    });
}
export function createUsageAccumulator(initialUsage) {
    let accumulated = addTokenUsage(undefined, initialUsage);
    return {
        add(usage, _options) {
            // Keep provider-reported input intact. Cached input is a subset of input,
            // not a replacement for it, and is accumulated as a separate dimension.
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
export function formatSessionTokenUsage(usage) {
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const cachedTokens = usage?.cache_read_tokens ?? 0;
    const cachedPart = cachedTokens > 0 ? ` (${cachedTokens.toLocaleString()} cached)` : '';
    return `Token usage: ${promptTokens.toLocaleString()} input${cachedPart}, ${completionTokens.toLocaleString()} output`;
}
export function formatUsageLine(label, usage) {
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const cachedTokens = usage?.cache_read_tokens ?? 0;
    const cachedPart = cachedTokens > 0 ? ` (${cachedTokens.toLocaleString()} cached)` : '';
    const value = `${promptTokens.toLocaleString()} input${cachedPart}, ${completionTokens.toLocaleString()} output`;
    return label ? `${label}: ${value}` : value;
}
/**
 * Format session usage with a breakdown of main vs subagent token usage.
 * Falls back to the legacy single-line format when there is no subagent usage.
 */
export function formatSessionUsageBreakdown(main, sub) {
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
//# sourceMappingURL=token-usage.js.map