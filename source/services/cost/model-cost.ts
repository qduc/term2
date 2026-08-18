/**
 * Provider-neutral model-request cost accounting.
 *
 * Owns pricing arithmetic, coverage rules, formatting, and accumulation for
 * the session-cost feature. This module is pure and deterministic: it has no
 * settings/provider imports, never performs network access, and returns typed
 * unpriced results rather than throwing or guessing for unsupported inputs.
 *
 * Costs are accumulated and persisted as integer USD micros (1/1_000_000 of a
 * USD). Provider decimal charges are converted without binary floating-point
 * arithmetic; each model request is rounded exactly once, then integers are
 * added.
 */
import { addTokenUsage, formatUsageLine, type NormalizedUsage } from '../../utils/ai/token-usage.js';

/** Where a request's USD charge came from. */
export type CostSource = 'provider' | 'catalog';

/** Billing service tier of a model request. */
export type ServiceTier = 'standard' | 'flex' | 'batch' | 'unknown';

/** Why a dispatched request has no priceable amount. */
export type UnpricedReason =
  | 'missing_usage'
  | 'unknown_provider'
  | 'unknown_model'
  | 'unknown_tier'
  | 'ambiguous_usage';

/** Outcome of a dispatched model request. */
export type CostOutcome = 'completed' | 'failed' | 'cancelled';

/** One cost record per dispatched model request. */
export interface ModelRequestCost {
  /** Stable run-local request id; guards against duplicate accounting. */
  requestId: string;
  provider: string;
  model: string;
  serviceTier: ServiceTier;
  outcome: CostOutcome;
  /** Normalized usage when the provider reported any. */
  usage?: NormalizedUsage;
  /** Integer USD micros when the request is priced. */
  usdMicros?: number;
  source?: CostSource;
  /** Catalog provenance when priced from the vendored catalog. */
  pricingVersion?: string;
  /**
   * Catalog provider whose rate was borrowed, set only when the request's own
   * provider carried no priced catalog entry.
   */
  pricedFromProvider?: string;
  unpricedReason?: UnpricedReason;
}

/** Immutable coverage summary for the session. */
export interface SessionCostSummary {
  /** Sum of priced request charges in integer USD micros. */
  knownUsdMicros: number;
  pricedRequests: number;
  unpricedRequests: number;
  state: 'exact' | 'estimated' | 'partial' | 'unavailable';
}

/** Token and cost totals for one provider/model pair in a session. */
export interface ModelUsageBreakdown {
  provider: string;
  model: string;
  usage: NormalizedUsage;
  cost: SessionCostSummary;
}

/** Non-overlapping per-million-token rates in USD. */
export interface CatalogPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Uncached-input rate when the provider distinguishes cache reads. */
  cacheReadPerMTok?: number;
  /** Cache-write/creation rate when the provider charges cache creation separately. */
  cacheWritePerMTok?: number;
}

/**
 * Result of a pricing lookup. The cost module consumes the typed failure so it
 * can report why a request is unpriced.
 */
export type PricingLookupResult =
  | {
      found: true;
      price: CatalogPrice;
      /**
       * Catalog provider the rate was borrowed from, set only when it is not
       * the requested provider. A borrowed rate is the same model at another
       * provider's price, so it is an estimate even by catalog standards.
       */
      pricedFromProvider?: string;
    }
  | { found: false; reason: Extract<UnpricedReason, 'unknown_provider' | 'unknown_model' | 'unknown_tier'> };

export interface ModelCostInput {
  requestId: string;
  provider: string;
  model: string;
  serviceTier: ServiceTier;
  outcome: CostOutcome;
  usage?: NormalizedUsage;
  /** Provider-reported charge in integer USD micros (wins over a decimal). */
  providerUsdMicros?: number;
  /** Provider-reported charge as a decimal USD number/string. */
  providerUsd?: number | string;
  /** Provider-scoped pricing lookup; returns a typed miss for unknown targets. */
  getPrice: (provider: string, model: string, tier: ServiceTier) => PricingLookupResult;
  /** Catalog provenance for catalog-priced requests. */
  pricingVersion?: string;
}

const USD_MICROS_PER_DOLLAR = 1_000_000;
const USD_MICROS_PER_CENT = 10_000;
const MICRO_FRACTION_DIGITS = 6;

/**
 * Convert a decimal USD charge into integer micros without binary
 * floating-point arithmetic. Decimal strings are parsed exactly (BigInt);
 * numeric inputs are first rendered as a plain decimal string, which is exact
 * for the finite decimal range providers and tests use.
 */
export function parseUsdMicros(value: number | string | undefined): number | undefined {
  if (value == null) return undefined;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    text = String(value);
    if (/[eE]/.test(text)) {
      // Exponent form (e.g. 1e-7): expand to a fixed micros string. The value
      // is outside the exact plain-decimal range anyway, so this is the best
      // micros representation available.
      text = value.toFixed(MICRO_FRACTION_DIGITS);
    }
  } else {
    text = value.trim();
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return undefined;

  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const dotIndex = unsigned.indexOf('.');
  const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1);
  // Round the fractional part to whole micros exactly once: keep seven digits
  // and round on the seventh (the digit beyond micro precision).
  const fracSeven = (fracPart + '0000000').slice(0, 7);
  const frac = fracSeven.slice(0, MICRO_FRACTION_DIGITS);

  let micros = BigInt(intPart || '0') * BigInt(USD_MICROS_PER_DOLLAR) + BigInt(frac || '0');
  if ((fracSeven[6] ?? '0') >= '5') micros += 1n;
  if (negative) micros = -micros;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER) || micros < BigInt(Number.MIN_SAFE_INTEGER)) return undefined;
  return Number(micros);
}

/** Billable token dimensions after normalizing a provider usage record. */
export interface BillableTokens {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export type BillableTokensResult = BillableTokens | 'missing' | 'ambiguous';

/**
 * Map normalized usage onto the non-overlapping billing dimensions.
 *
 * `prompt_tokens` is the full prompt including cache reads, so cached input is
 * subtracted from it to derive the uncached share. Cache-creation tokens are
 * charged from `cache_creation_tokens` only — never inferred from
 * `total_tokens`. Reasoning tokens are a subset of output tokens and are not
 * billed a second time.
 *
 * Returns `'missing'` when there is no usage and `'ambiguous'` when usage
 * cannot be fully mapped (e.g. uncached input or output tokens are unknown).
 */
export function resolveBillableTokens(usage: NormalizedUsage | null | undefined): BillableTokensResult {
  if (!usage || Object.keys(usage).length === 0) return 'missing';

  const cachedInputTokens = usage.cache_read_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_tokens ?? 0;
  // The uncached share requires the provider to report the full prompt input.
  const uncachedInputTokens =
    usage.prompt_tokens != null ? Math.max(0, usage.prompt_tokens - cachedInputTokens) : undefined;
  const outputTokens = usage.completion_tokens;

  if (uncachedInputTokens === undefined || outputTokens === undefined) return 'ambiguous';

  return { uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens };
}

function toMicros(dollarsPerMTok: number, tokens: number): number {
  // tokens/1e6 * dollarsPerMTok * 1e6 micros = tokens * dollarsPerMTok micros.
  // Scale the rate by 1000 and divide back so only the final rounding is a
  // fractional operation.
  const scaled = dollarsPerMTok * 1000;
  return Math.round((tokens * scaled) / 1000);
}

/**
 * Compute the cost record for one completed model request. Provider-reported
 * charges win over catalog estimates; unsupported inputs produce typed
 * unpriced records rather than guesses.
 */
export function computeModelCost(input: ModelCostInput): ModelRequestCost {
  const base = {
    requestId: input.requestId,
    provider: input.provider,
    model: input.model,
    serviceTier: input.serviceTier,
    outcome: input.outcome,
    ...(input.usage ? { usage: input.usage } : {}),
  };

  const providerUsdMicros =
    input.providerUsdMicros !== undefined ? input.providerUsdMicros : parseUsdMicros(input.providerUsd);
  if (providerUsdMicros !== undefined) {
    return { ...base, usdMicros: providerUsdMicros, source: 'provider' };
  }

  const tokens = resolveBillableTokens(input.usage);
  if (tokens === 'missing') return { ...base, unpricedReason: 'missing_usage' };
  if (tokens === 'ambiguous') return { ...base, unpricedReason: 'ambiguous_usage' };

  const lookup = input.getPrice(input.provider, input.model, input.serviceTier);
  if (!lookup.found) return { ...base, unpricedReason: lookup.reason };

  const { price } = lookup;
  const uncachedMicros = toMicros(price.inputPerMTok, tokens.uncachedInputTokens);
  const cachedMicros = price.cacheReadPerMTok != null ? toMicros(price.cacheReadPerMTok, tokens.cachedInputTokens) : 0;
  const cacheWriteMicros =
    price.cacheWritePerMTok != null ? toMicros(price.cacheWritePerMTok, tokens.cacheWriteTokens) : 0;
  const outputMicros = toMicros(price.outputPerMTok, tokens.outputTokens);

  return {
    ...base,
    usdMicros: uncachedMicros + cachedMicros + cacheWriteMicros + outputMicros,
    source: 'catalog',
    ...(input.pricingVersion ? { pricingVersion: input.pricingVersion } : {}),
    ...(lookup.pricedFromProvider ? { pricedFromProvider: lookup.pricedFromProvider } : {}),
  };
}

/** Produce the session coverage summary from the accumulated request records. */
export function summarizeCost(records: readonly ModelRequestCost[]): SessionCostSummary {
  let knownUsdMicros = 0;
  let pricedRequests = 0;
  let unpricedRequests = 0;
  let anyEstimated = false;

  for (const record of records) {
    if (record.usdMicros !== undefined) {
      knownUsdMicros += record.usdMicros;
      pricedRequests += 1;
      if (record.source === 'catalog') anyEstimated = true;
    } else {
      unpricedRequests += 1;
    }
  }

  let state: SessionCostSummary['state'];
  if (pricedRequests === 0) {
    state = 'unavailable';
  } else if (unpricedRequests > 0) {
    state = 'partial';
  } else {
    state = anyEstimated ? 'estimated' : 'exact';
  }

  return { knownUsdMicros, pricedRequests, unpricedRequests, state };
}

/** Group request records by provider/model while preserving first-seen order. */
export function summarizeModelUsage(records: readonly ModelRequestCost[]): ModelUsageBreakdown[] {
  const groups = new Map<
    string,
    { provider: string; model: string; usage: NormalizedUsage; records: ModelRequestCost[] }
  >();

  for (const record of records) {
    const key = `${record.provider}\u0000${record.model}`;
    let group = groups.get(key);
    if (!group) {
      group = { provider: record.provider, model: record.model, usage: {}, records: [] };
      groups.set(key, group);
    }
    group.usage = addTokenUsage(group.usage, record.usage);
    group.records.push(record);
  }

  return [...groups.values()].map((group) => ({
    provider: group.provider,
    model: group.model,
    usage: group.usage,
    cost: summarizeCost(group.records),
  }));
}

function formatModelCost(cost: SessionCostSummary): string {
  switch (cost.state) {
    case 'exact':
      return `Cost ${formatUsdMicros(cost.knownUsdMicros)}`;
    case 'estimated':
      return `Estimated cost ${formatUsdMicros(cost.knownUsdMicros)}`;
    case 'partial':
      return `Estimated cost ${formatUsdMicros(cost.knownUsdMicros)}+`;
    case 'unavailable':
      return 'Cost unavailable';
  }
}

/** Format token and cost totals for each model in a session. */
export function formatModelUsageBreakdown(breakdowns: readonly ModelUsageBreakdown[]): string {
  if (breakdowns.length === 0) return '';

  const lines = breakdowns.map(({ provider, model, usage, cost }) => {
    const usageText = Object.keys(usage).length > 0 ? formatUsageLine('', usage) : 'tokens unavailable';
    return `  ${provider}/${model}: ${usageText}; ${formatModelCost(cost)}`;
  });
  return `By model:\n${lines.join('\n')}`;
}

/**
 * Format integer micros as USD.
 *
 * - two decimals at or above one cent (rounded once);
 * - enough precision below one cent that a positive cost is never `$0.00`;
 * - a locale-independent `.` separator;
 * - exactly `$0.00` for zero.
 */
export function formatUsdMicros(usdMicros: number): string {
  const sign = usdMicros < 0 ? '-' : '';
  const abs = Math.abs(usdMicros);
  if (abs === 0) return '$0.00';

  const dollars = Math.floor(abs / USD_MICROS_PER_DOLLAR);
  const fraction = abs % USD_MICROS_PER_DOLLAR;

  if (abs >= USD_MICROS_PER_CENT) {
    const centsWithCarry = Math.round(fraction / USD_MICROS_PER_CENT);
    const totalCents = dollars * 100 + centsWithCarry;
    const whole = Math.floor(totalCents / 100);
    const cents = totalCents % 100;
    return `${sign}$${whole}.${String(cents).padStart(2, '0')}`;
  }

  const microsText = String(fraction).padStart(MICRO_FRACTION_DIGITS, '0').replace(/0+$/, '');
  return `${sign}$0.${microsText || '0'}`;
}

export interface SessionCostAccumulator {
  /** Add one request record, ignoring duplicate request ids. */
  addRecord(record: ModelRequestCost): void;
  /** Add several records, ignoring duplicate request ids. */
  addRecords(records: readonly ModelRequestCost[]): void;
  reset(): void;
  getSummary(): SessionCostSummary;
  getModelUsageBreakdown(): readonly ModelUsageBreakdown[];
}

const EMPTY_SUMMARY: SessionCostSummary = {
  knownUsdMicros: 0,
  pricedRequests: 0,
  unpricedRequests: 0,
  state: 'unavailable',
};

/**
 * Session-scoped cost accumulator. Emits an immutable summary after every
 * add/reset so the status bar is reactive without reading a mutated object
 * during an unrelated render. Duplicate delivery of the same request record
 * (identified by its run-local request id) is ignored so a record is never
 * double-counted.
 */
export function createSessionCostAccumulator(options?: {
  onUpdate?: (summary: SessionCostSummary) => void;
}): SessionCostAccumulator {
  let records: ModelRequestCost[] = [];
  let summary: SessionCostSummary = { ...EMPTY_SUMMARY };
  const seenRequestIds = new Set<string>();

  const emit = (): void => {
    options?.onUpdate?.(summary);
  };

  const add = (record: ModelRequestCost): void => {
    if (record.requestId && seenRequestIds.has(record.requestId)) return;
    if (record.requestId) seenRequestIds.add(record.requestId);
    records = [...records, record];
    summary = summarizeCost(records);
    emit();
  };

  return {
    addRecord: add,
    addRecords(recordsToAdd) {
      for (const record of recordsToAdd) add(record);
    },
    reset() {
      records = [];
      seenRequestIds.clear();
      summary = { ...EMPTY_SUMMARY };
      emit();
    },
    getSummary() {
      return summary;
    },
    getModelUsageBreakdown() {
      return summarizeModelUsage(records);
    },
  };
}
