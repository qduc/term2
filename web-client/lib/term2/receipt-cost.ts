import type { NativeRequestCost } from './native-state';

/** Pricing of the supplied receipt set only, never historical billing coverage. */
export interface ReceiptCostSummary {
  readonly knownUsdMicros: number;
  readonly pricedRequests: number;
  readonly unpricedRequests: number;
  readonly state: 'exact' | 'estimated' | 'partial' | 'unavailable';
}

/** Pure presentation of validated physical receipts, latest complete record per
 * real requestId. Undefined means evidence unavailable, not an empty receipt set.
 * Pricing state describes only these receipts; historical coverage stays unknown.
 * Branch views select the same root charges and must never be added to this set.
 * No usage/catalog lookup, native-aggregate reconciliation, or accepted state write.
 *
 * Arithmetic follows rewrite/src/shared/cost/model-cost.ts#summarizeCost. Its runtime
 * import is not Turbopack-compatible (.js -> .ts dependency), and even a type-only
 * import checks BigInt literals against the browser's ES2017 target. No source
 * runtime or type dependency is pulled into this browser module.
 */
export function summarizeReceiptCosts(receipts: readonly NativeRequestCost[] | undefined): ReceiptCostSummary | undefined {
  if (receipts === undefined) return undefined;
  const latest = new Map(receipts.map(receipt => [receipt.record.requestId, receipt.record]));
  let knownUsdMicros = 0;
  let pricedRequests = 0;
  let unpricedRequests = 0;
  let anyEstimated = false;
  for (const record of latest.values()) {
    if (record.usdMicros !== undefined) {
      knownUsdMicros += record.usdMicros;
      pricedRequests++;
      if (record.source === 'catalog') anyEstimated = true;
    } else {
      unpricedRequests++;
    }
  }
  const state = pricedRequests === 0 ? 'unavailable' : unpricedRequests > 0 ? 'partial' : anyEstimated ? 'estimated' : 'exact';
  return { knownUsdMicros, pricedRequests, unpricedRequests, state };
}
