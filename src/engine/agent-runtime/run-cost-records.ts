import { getCatalogPricingVersion, getModelPricing } from '../../model/cost/pricing.js';
import type { StreamedModelTurnRequest } from '../../model/streamed-model-turn.js';
import { computeModelCost, type ModelRequestCost, type ServiceTier } from '../../shared/cost/model-cost.js';
import { normalizeUsage } from '../../shared/utils/ai/token-usage.js';
import type { RunState } from './run-state.js';
/**
 * Process-wide monotonic counter for model-request cost ids.
 *
 * Request ids must be unique across every run in the process: root runs,
 * subagent runs, and approval continuations all feed the same session
 * accumulator, which dedups by id to make event + terminal double-delivery
 * safe. A run-local sequence (as in a per-run counter) would collide across
 * turns and silently drop later turns' records.
 */
let nextCostRequestSeq = 0;
export function nextRequestId(): string {
  nextCostRequestSeq += 1;
  return `req-${nextCostRequestSeq}`;
}

export function appendCostRecord(
  state: RunState,
  input: {
    requestId: string;
    provider: string | undefined;
    model: string;
    tier: ServiceTier;
    outcome: 'completed' | 'failed' | 'cancelled';
    usage?: ReturnType<typeof normalizeModelUsage>;
    providerUsd?: number | string;
  },
): ModelRequestCost {
  const record = computeModelCost({
    requestId: input.requestId,
    provider: input.provider ?? 'unknown',
    model: input.model,
    serviceTier: input.tier,
    outcome: input.outcome,
    usage: input.usage,
    providerUsd: input.providerUsd,
    getPrice: (provider, model, tier) => getModelPricing(provider, model, tier),
    pricingVersion: getCatalogPricingVersion(),
  });
  state.costRecords = [...(state.costRecords ?? []), record];
  return record;
}
/**
 * Resolve the effective billing service tier from the dispatched request. The
 * default service tier is standard; only a flex/batch request that was actually
 * dispatched resolves to its tier, and anything unrecognized fails closed.
 */
export function resolveServiceTier(request: StreamedModelTurnRequest): ServiceTier {
  const options = request.providerOptions as Record<string, unknown> | undefined;
  const raw = options?.service_tier ?? options?.serviceTier;
  if (raw === 'flex' || raw === 'batch' || raw === 'standard') return raw;
  return raw === undefined ? 'standard' : 'unknown';
}

export function normalizeModelUsage(usage: unknown) {
  if (!usage || typeof usage !== 'object') return undefined;
  const rawUsage = usage as Record<string, unknown>;
  return normalizeUsage({
    ...rawUsage,
    cacheReadTokens: rawUsage.cachedInputTokens ?? rawUsage.cacheReadTokens,
    cacheCreationTokens: rawUsage.cacheWriteTokens ?? rawUsage.cacheCreationTokens,
    // AI SDK v3 `outputTokens.reasoning` (incl. OpenRouter) has no
    // snake_case twin in `normalizeUsage`; forward it explicitly so hidden
    // reasoning is subtracted from settled tok/s.
    reasoningTokens:
      (rawUsage as { outputTokens?: { reasoning?: unknown } }).outputTokens?.reasoning ?? rawUsage.reasoningTokens,
  });
}
