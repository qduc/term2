import { stdout } from 'node:process';
import {
  formatModelUsageBreakdown,
  formatUsdMicros,
  summarizeCost,
  summarizeModelUsage,
} from '../../../source/services/cost/model-cost.js';
import { formatSessionUsageBreakdown } from '../clients/tui/presentation/utils/ai/token-usage.js';
import type { WireSnapshot } from '../protocol/direct-wire.js';

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
  return { tokens, models: formatModelUsageBreakdown(summarizeModelUsage(records)), cost: summarizeCost(records) };
}

/** Legacy app.tsx getSessionUsage: the /usage line. */
export function sessionUsage(snapshot: WireSnapshot): string {
  const { tokens, models, cost } = totals(snapshot);
  if (cost.state === 'unavailable') return models ? `${tokens}\n${models}` : tokens;
  const costLabel = cost.state === 'exact' ? 'Cost' : 'Estimated cost';
  const costAmount = `${formatUsdMicros(cost.knownUsdMicros)}${cost.state === 'partial' ? '+' : ''}`;
  const lowerBound = cost.state === 'partial' ? ' (lower bound)' : '';
  const costUsage = `${costLabel}: ${costAmount}${lowerBound} (${cost.pricedRequests} priced, ${cost.unpricedRequests} unpriced requests)`;
  return [tokens, models, costUsage].filter(Boolean).join('\n');
}

/**
 * Legacy cli.tsx printUsage, written straight to stdout under Ink's live frame on /clear, rollover and exit.
 * Ink then erases its frame from the moved cursor, so the frame's top rows stay behind; legacy shows that too.
 */
export function printUsage(snapshot: WireSnapshot | undefined): void {
  const { tokens, models, cost } = totals(snapshot);
  const costLine =
    cost.state === 'exact'
      ? `Cost ${formatUsdMicros(cost.knownUsdMicros)}`
      : cost.state === 'estimated'
      ? `Est ${formatUsdMicros(cost.knownUsdMicros)}`
      : cost.state === 'partial'
      ? `Est ${formatUsdMicros(cost.knownUsdMicros)}+`
      : null;
  stdout.write(`\n${[tokens, models, costLine].filter(Boolean).join('\n')}\n`);
}
