import { describe, expect, it } from 'vitest';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import {
  computeModelCost,
  createSessionCostAccumulator,
  formatUsdMicros,
  parseUsdMicros,
  resolveBillableTokens,
  summarizeCost,
  type CatalogPrice,
  type ModelCostInput,
  type ModelRequestCost,
  type PricingLookupResult,
} from './model-cost.js';

/** A stub pricing lookup with a fixed result. */
function stubPrice(
  price: CatalogPrice | undefined,
  reason: 'unknown_provider' | 'unknown_model' | 'unknown_tier' = 'unknown_model',
) {
  return (): PricingLookupResult => (price ? { found: true, price } : { found: false, reason });
}

const STANDARD_PRICE: CatalogPrice = {
  inputPerMTok: 2,
  outputPerMTok: 8,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 0,
};

function baseInput(overrides: Partial<ModelCostInput> = {}): ModelCostInput {
  return {
    requestId: 'req-1',
    provider: 'openai',
    model: 'gpt-4.1',
    serviceTier: 'standard',
    outcome: 'completed',
    usage: { prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 100 },
    getPrice: stubPrice(STANDARD_PRICE),
    pricingVersion: 'pi-ai@0.83.0',
    ...overrides,
  };
}

describe('parseUsdMicros', () => {
  it('parses a plain decimal string into integer micros without binary-float drift', () => {
    expect(parseUsdMicros('0.00002772')).toBe(28);
    expect(parseUsdMicros('0.42')).toBe(420000);
    expect(parseUsdMicros('1.5')).toBe(1_500_000);
    expect(parseUsdMicros('0.1')).toBe(100_000);
    expect(parseUsdMicros('12')).toBe(12_000_000);
  });

  it('rounds beyond six decimal places once to whole micros', () => {
    // 0.000027729 -> 27.729 micros -> 28; 0.0000274 -> 27.4 -> 27.
    expect(parseUsdMicros('0.000027729')).toBe(28);
    expect(parseUsdMicros('0.0000274')).toBe(27);
  });

  it('carries the round into whole dollars', () => {
    expect(parseUsdMicros('0.9999999')).toBe(1_000_000);
  });

  it('accepts a leading plus or minus sign', () => {
    expect(parseUsdMicros('+1.25')).toBe(1_250_000);
    expect(parseUsdMicros('-0.5')).toBe(-500_000);
  });

  it('handles an integer without a decimal point', () => {
    expect(parseUsdMicros('3')).toBe(3_000_000);
  });

  it('returns undefined for non-numeric or malformed input', () => {
    expect(parseUsdMicros(undefined)).toBeUndefined();
    expect(parseUsdMicros('abc')).toBeUndefined();
    expect(parseUsdMicros('')).toBeUndefined();
    expect(parseUsdMicros('1.2.3')).toBeUndefined();
    expect(parseUsdMicros('$0.42')).toBeUndefined();
    expect(parseUsdMicros('1e-5')).toBeUndefined();
    expect(parseUsdMicros(Number.NaN)).toBeUndefined();
    expect(parseUsdMicros(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('converts a numeric USD charge to micros deterministically', () => {
    expect(parseUsdMicros(0.42)).toBe(420000);
    expect(parseUsdMicros(0.00002772)).toBe(28);
  });
});

describe('resolveBillableTokens', () => {
  it('removes cached input from the full prompt and keeps each dimension separate', () => {
    const usage: NormalizedUsage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      cache_read_tokens: 100,
      cache_creation_tokens: 50,
      reasoning_tokens: 60,
    };
    expect(resolveBillableTokens(usage)).toEqual({
      uncachedInputTokens: 900,
      cachedInputTokens: 100,
      cacheWriteTokens: 50,
      outputTokens: 200,
    });
  });

  it('treats reasoning tokens as informational (subset of output), never billed twice', () => {
    const usage: NormalizedUsage = { prompt_tokens: 10, completion_tokens: 100, reasoning_tokens: 100 };
    expect(resolveBillableTokens(usage)).toMatchObject({ outputTokens: 100 });
  });

  it('returns missing when usage is absent or empty', () => {
    expect(resolveBillableTokens(undefined)).toBe('missing');
    expect(resolveBillableTokens({})).toBe('missing');
  });

  it('returns ambiguous when prompt tokens are unknown (uncached input cannot be established)', () => {
    expect(resolveBillableTokens({ cache_read_tokens: 100, completion_tokens: 50 })).toBe('ambiguous');
    expect(resolveBillableTokens({ cache_read_tokens: 100 })).toBe('ambiguous');
  });

  it('returns ambiguous when output tokens are unknown', () => {
    expect(resolveBillableTokens({ prompt_tokens: 100 })).toBe('ambiguous');
  });

  it('does not let cache_creation_tokens be inferred from total_tokens', () => {
    const usage: NormalizedUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    expect(resolveBillableTokens(usage)).toMatchObject({ cacheWriteTokens: 0 });
  });
});

describe('computeModelCost', () => {
  it('computes standard input/output arithmetic in integer micros', () => {
    const cost = computeModelCost(baseInput());
    // uncached 900 * $2/1M = 1800 micros; cached 100 * $0.5/1M = 50;
    // output 200 * $8/1M = 1600 micros. Total 3450.
    expect(cost.usdMicros).toBe(3450);
    expect(cost.source).toBe('catalog');
    expect(cost.pricingVersion).toBe('pi-ai@0.83.0');
    expect(cost.outcome).toBe('completed');
    expect(cost.requestId).toBe('req-1');
  });

  it('charges cache creation once at the cache-write rate', () => {
    const cost = computeModelCost(
      baseInput({ usage: { prompt_tokens: 100, completion_tokens: 0, cache_creation_tokens: 1000 } }),
    );
    // 100 uncached input * $2/1M = 200 micros; 1000 cache write * $0/1M = 0.
    expect(cost.usdMicros).toBe(200);
  });

  it('prefers a provider-reported charge over a catalog estimate without adding both', () => {
    const cost = computeModelCost(baseInput({ providerUsdMicros: 987654 }));
    expect(cost.usdMicros).toBe(987654);
    expect(cost.source).toBe('provider');
    // The catalog estimate is never added.
    expect(cost.usdMicros).not.toBe(3450);
  });

  it('parses a provider-reported decimal string charge', () => {
    const cost = computeModelCost(baseInput({ providerUsd: '0.00002772' }));
    expect(cost.usdMicros).toBe(28);
    expect(cost.source).toBe('provider');
  });

  it('records missing_usage when usage is absent', () => {
    const cost = computeModelCost(baseInput({ usage: undefined }));
    expect(cost.usdMicros).toBeUndefined();
    expect(cost.unpricedReason).toBe('missing_usage');
    expect(cost.source).toBeUndefined();
  });

  it('records ambiguous_usage when usage cannot be mapped to billing dimensions', () => {
    const cost = computeModelCost(baseInput({ usage: { cache_read_tokens: 10 } }));
    expect(cost.unpricedReason).toBe('ambiguous_usage');
  });

  it('records unknown_model / unknown_provider / unknown_tier when the lookup fails closed', () => {
    const unknownModel = computeModelCost(baseInput({ getPrice: stubPrice(undefined, 'unknown_model') }));
    expect(unknownModel.unpricedReason).toBe('unknown_model');

    const unknownProvider = computeModelCost(baseInput({ getPrice: stubPrice(undefined, 'unknown_provider') }));
    expect(unknownProvider.unpricedReason).toBe('unknown_provider');

    const unknownTier = computeModelCost(baseInput({ getPrice: stubPrice(undefined, 'unknown_tier') }));
    expect(unknownTier.unpricedReason).toBe('unknown_tier');
  });

  it('records which provider a borrowed rate came from, and omits the field otherwise', () => {
    const borrowed = computeModelCost(
      baseInput({
        provider: 'my-gateway',
        getPrice: () => ({ found: true, price: STANDARD_PRICE, pricedFromProvider: 'anthropic' }),
      }),
    );
    expect(borrowed.pricedFromProvider).toBe('anthropic');
    expect(borrowed.source).toBe('catalog');
    // The borrowed rate still prices the request normally.
    expect(borrowed.usdMicros).toBe(3450);

    expect(computeModelCost(baseInput()).pricedFromProvider).toBeUndefined();
  });

  it('records a failed/cancelled request without billable evidence as unpriced', () => {
    const failed = computeModelCost(baseInput({ outcome: 'failed', usage: undefined }));
    expect(failed.outcome).toBe('failed');
    expect(failed.unpricedReason).toBe('missing_usage');

    const cancelled = computeModelCost(baseInput({ outcome: 'cancelled', usage: undefined }));
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.unpricedReason).toBe('missing_usage');
  });

  it('never fabricates zero cost for a failed request without usage', () => {
    const failed = computeModelCost(baseInput({ outcome: 'failed', usage: undefined }));
    expect(failed.usdMicros).toBeUndefined();
    expect(failed.source).toBeUndefined();
  });
});

describe('summarizeCost coverage states', () => {
  let counter = 0;
  const priced = (source: 'provider' | 'catalog', usdMicros = 100): ModelRequestCost => ({
    requestId: `r-${counter++}`,
    provider: 'openai',
    model: 'gpt-4.1',
    serviceTier: 'standard',
    outcome: 'completed',
    usdMicros,
    source,
  });
  const unpriced = (): ModelRequestCost => ({
    requestId: `r-${counter++}`,
    provider: 'openai',
    model: 'gpt-4.1',
    serviceTier: 'standard',
    outcome: 'failed',
    unpricedReason: 'missing_usage',
  });

  it('is exact when every counted request carried a provider charge', () => {
    const summary = summarizeCost([priced('provider', 100), priced('provider', 200)]);
    expect(summary).toMatchObject({
      knownUsdMicros: 300,
      pricedRequests: 2,
      unpricedRequests: 0,
      state: 'exact',
    });
  });

  it('is estimated when every counted request is priced but at least one used the catalog', () => {
    const summary = summarizeCost([priced('provider', 100), priced('catalog', 200)]);
    expect(summary.state).toBe('estimated');
  });

  it('is partial when some incurred requests are priced and some are not', () => {
    const summary = summarizeCost([priced('provider', 100), unpriced()]);
    expect(summary.state).toBe('partial');
    expect(summary.knownUsdMicros).toBe(100);
    expect(summary.pricedRequests).toBe(1);
    expect(summary.unpricedRequests).toBe(1);
  });

  it('is unavailable when no incurred request can be priced', () => {
    const summary = summarizeCost([unpriced(), unpriced()]);
    expect(summary.state).toBe('unavailable');
    expect(summary.knownUsdMicros).toBe(0);
  });

  it('is unavailable for an empty record set', () => {
    expect(summarizeCost([]).state).toBe('unavailable');
  });
});

describe('formatUsdMicros', () => {
  it('renders two decimals at or above one cent with a locale-independent dot', () => {
    expect(formatUsdMicros(420000)).toBe('$0.42');
    expect(formatUsdMicros(1_500_000)).toBe('$1.50');
    expect(formatUsdMicros(12_000_000)).toBe('$12.00');
  });

  it('rounds to cents at or above one cent', () => {
    expect(formatUsdMicros(424999)).toBe('$0.42');
    expect(formatUsdMicros(425000)).toBe('$0.43');
  });

  it('keeps enough precision below one cent to avoid rendering a positive cost as $0.00', () => {
    expect(formatUsdMicros(28)).toBe('$0.000028');
    expect(formatUsdMicros(1)).toBe('$0.000001');
    expect(formatUsdMicros(9999)).toBe('$0.009999');
  });

  it('renders exactly zero as $0.00', () => {
    expect(formatUsdMicros(0)).toBe('$0.00');
  });

  it('handles negative values symmetrically', () => {
    expect(formatUsdMicros(-420000)).toBe('-$0.42');
  });
});

describe('createSessionCostAccumulator', () => {
  it('emits an immutable summary after each add and reset', () => {
    const updates: Array<{ knownUsdMicros: number; state: string }> = [];
    const accumulator = createSessionCostAccumulator({
      onUpdate: (summary) => updates.push({ knownUsdMicros: summary.knownUsdMicros, state: summary.state }),
    });
    accumulator.addRecord(computeModelCost(baseInput({ requestId: 'a', providerUsdMicros: 100 })));
    accumulator.addRecord(computeModelCost(baseInput({ requestId: 'b', usage: undefined })));
    expect(updates).toEqual([
      { knownUsdMicros: 100, state: 'exact' },
      { knownUsdMicros: 100, state: 'partial' },
    ]);
    const snapshot = accumulator.getSummary();
    expect(snapshot).toMatchObject({ knownUsdMicros: 100, state: 'partial' });

    accumulator.reset();
    expect(accumulator.getSummary()).toMatchObject({ knownUsdMicros: 0, state: 'unavailable' });
    expect(updates[updates.length - 1]).toEqual({ knownUsdMicros: 0, state: 'unavailable' });
  });

  it('does not double-count the same request record delivered twice', () => {
    const accumulator = createSessionCostAccumulator();
    const record = computeModelCost(baseInput({ requestId: 'dup-1', providerUsdMicros: 500 }));
    accumulator.addRecord(record);
    accumulator.addRecord(record);
    accumulator.addRecords([record]);
    expect(accumulator.getSummary()).toMatchObject({
      knownUsdMicros: 500,
      pricedRequests: 1,
    });
  });

  it('treats distinct request ids as distinct even with identical values', () => {
    const accumulator = createSessionCostAccumulator();
    accumulator.addRecord(computeModelCost(baseInput({ requestId: 'x', providerUsdMicros: 100 })));
    accumulator.addRecord(computeModelCost(baseInput({ requestId: 'y', providerUsdMicros: 100 })));
    expect(accumulator.getSummary()).toMatchObject({ knownUsdMicros: 200, pricedRequests: 2 });
  });
});
