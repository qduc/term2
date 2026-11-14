/** Term2 session aggregation and presentation around portable cost arithmetic. */
import { addTokenUsage, formatUsageLine, type NormalizedUsage } from '../utils/ai/token-usage.js';
import type { ModelRequestCost, SessionCostSummary, ModelUsageBreakdown } from '@qduc/agent-core';
export {
  type CostSource,
  type ServiceTier,
  type UnpricedReason,
  type CostOutcome,
  type ModelRequestCost,
  type SessionCostSummary,
  type ModelUsageBreakdown,
  type CatalogPrice,
  type PricingLookupResult,
  type ModelCostInput,
  type BillableTokens,
  type BillableTokensResult,
  isValidCatalogPrice,
  parseUsdMicros,
  resolveBillableTokens,
  computeModelCost,
} from '@qduc/agent-core';
const USD_MICROS_PER_DOLLAR = 1_000_000;
const USD_MICROS_PER_CENT = 10_000;
const MICRO_FRACTION_DIGITS = 6;
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

/** Compact coverage-aware footer text; unavailable cost is omitted rather than shown as $0.00. */
export function formatSessionCost(cost: SessionCostSummary): string | undefined {
  switch (cost.state) {
    case 'exact':
      return `Cost ${formatUsdMicros(cost.knownUsdMicros)}`;
    case 'estimated':
      return `Est ${formatUsdMicros(cost.knownUsdMicros)}`;
    case 'partial':
      return `Est ${formatUsdMicros(cost.knownUsdMicros)}+`;
    case 'unavailable':
      return undefined;
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

function costRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A usable charge: a finite, non-negative number or numeric string; anything else is unusable. */
function usableCost(value: unknown): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? value : undefined;
}

/**
 * The charge a provider usage object reports, in provider units (USD for OpenRouter). Reads the
 * snake_case wire fields and the camelCase forms AI SDK provider metadata uses.
 *
 * OpenRouter reports `cost` as what it charged the account's credits and
 * `cost_details.upstream_inference_cost` as what the upstream provider charged. Without
 * bring-your-own-key they describe the same request (`upstream_inference_cost` is OpenRouter's
 * upstream bill, close to `cost`; see the `is_byok: false` frames in the OpenRouter provider
 * fixtures), so adding them would double count. With `is_byok: true` OpenRouter bills only its
 * BYOK fee (often `cost: 0`) and the upstream charge goes to the user's own key, so the request
 * costs the sum. Reading `cost` alone recorded those requests as an exact $0, which hid them from
 * run summaries and the run budget.
 *
 * A BYOK frame without a usable upstream figure (or with an unusable `cost`) returns undefined so
 * the request is estimated or unpriced rather than an exact fee-only charge. Otherwise a missing
 * `cost` falls back to the upstream figure. Negative or non-finite values are unusable.
 */
export function reportedUsageCost(usage: unknown): number | string | undefined {
  const record = costRecord(usage);
  if (!record) return undefined;
  const cost = usableCost(record.cost);
  const details = costRecord(record.cost_details) ?? costRecord(record.costDetails);
  const upstream = usableCost(details?.upstream_inference_cost ?? details?.upstreamInferenceCost);
  if ((record.is_byok ?? record.isByok) === true) {
    if (upstream === undefined || (record.cost != null && cost === undefined)) return undefined;
    return Number(cost ?? 0) + Number(upstream);
  }
  return cost ?? upstream;
}
