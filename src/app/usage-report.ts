import { stdout } from 'node:process';
import {
  formatModelUsageBreakdown,
  formatReferenceCost,
  formatSessionCost,
  formatUsdMicros,
  summarizeCost,
  summarizeModelUsage,
} from '../shared/cost/model-cost.js';
import { formatSessionUsageBreakdown } from '../clients/tui/presentation/utils/ai/token-usage.js';
import type { WireSnapshot } from '../protocol/wire.js';
import { subscriptionReferenceCost } from '../protocol/reference-cost.js';

/** The session's counts, as legacy's accumulators hold them (reset on /clear, rollover and resume). */
function totals(snapshot: WireSnapshot | undefined) {
  const usage = snapshot?.usage;
  const records = (snapshot?.requestCosts ?? []).map(({ record }) => record);
  const tokens = formatSessionUsageBreakdown(
    {
      prompt_tokens: usage?.inputTokens ?? 0,
      completion_tokens: usage?.outputTokens ?? 0,
      cache_read_tokens: usage?.cachedInputTokens ?? 0,
    },
    undefined,
  );
  return {
    tokens,
    models: formatModelUsageBreakdown(summarizeModelUsage(records)),
    cost: summarizeCost(records),
    reference: subscriptionReferenceCost(records),
  };
}

/** Legacy app.tsx getSessionUsage: the /usage line. */
export function sessionUsage(snapshot: WireSnapshot): string {
  const { tokens, models, cost, reference } = totals(snapshot);
  const referenceLine = reference
    ? `${formatReferenceCost(reference)} (current catalog comparison, not billed cost; ${
        reference.pricedRequests
      } priced, ${reference.unpricedRequests} unpriced requests${reference.state === 'partial' ? '; lower bound' : ''})`
    : '';
  if (cost.state === 'unavailable') return [tokens, models, referenceLine].filter(Boolean).join('\n');
  const costLabel = cost.state === 'exact' ? 'Cost' : 'Estimated cost';
  const costAmount = `${formatUsdMicros(cost.knownUsdMicros)}${cost.state === 'partial' ? '+' : ''}`;
  const lowerBound = cost.state === 'partial' ? ' (lower bound)' : '';
  const costUsage = `${costLabel}: ${costAmount}${lowerBound} (${cost.pricedRequests} priced, ${cost.unpricedRequests} unpriced requests)`;
  return [tokens, models, costUsage, referenceLine].filter(Boolean).join('\n');
}

/**
 * Legacy cli.tsx printUsage, written straight to stdout under Ink's live frame on /clear, rollover and exit.
 * Ink then erases its frame from the moved cursor, so the frame's top rows stay behind; legacy shows that too.
 */
export function printUsage(snapshot: WireSnapshot | undefined): void {
  const { tokens, models, cost, reference } = totals(snapshot);
  const costLine = formatSessionCost(cost);
  stdout.write(
    `\n${[
      tokens,
      models,
      costLine,
      reference ? `${formatReferenceCost(reference)} (catalog comparison, not billed cost)` : '',
    ]
      .filter(Boolean)
      .join('\n')}\n`,
  );
}
