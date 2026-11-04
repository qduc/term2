import { stdout } from 'node:process';
import {
  formatModelUsageBreakdown,
  formatUsdMicros,
  summarizeCost,
  summarizeModelUsage,
  type ModelRequestCost,
} from '../../../source/services/cost/model-cost.js';
import { formatSessionUsageBreakdown } from '../clients/tui/presentation/utils/ai/token-usage.js';
import type { WireSnapshot } from '../protocol/direct-wire.js';

/**
 * Legacy cli.tsx keeps one usage accumulator for the whole process: a /clear, rollover or handoff starts a new
 * conversation but not a new count. Next's snapshots count per session, so the sessions this process left are
 * carried here. Not carried: a session left through /resume (legacy counts what it ran there; next forgets it).
 */
const carried = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, records: [] as ModelRequestCost[] };

function totals(snapshot: WireSnapshot | undefined) {
  const usage = snapshot?.usage;
  const records = [...carried.records, ...(snapshot?.requestCosts ?? []).map(({ record }) => record)];
  const tokens = formatSessionUsageBreakdown(
    {
      prompt_tokens: carried.inputTokens + (usage?.inputTokens ?? 0),
      completion_tokens: carried.outputTokens + (usage?.outputTokens ?? 0),
      cache_read_tokens: carried.cachedInputTokens + (usage?.cachedInputTokens ?? 0),
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
 * `leaving` carries the session's count into the next one.
 */
export function printUsage(snapshot: WireSnapshot | undefined, leaving: boolean): void {
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
  if (!leaving || !snapshot) return;
  carried.inputTokens += snapshot.usage?.inputTokens ?? 0;
  carried.outputTokens += snapshot.usage?.outputTokens ?? 0;
  carried.cachedInputTokens += snapshot.usage?.cachedInputTokens ?? 0;
  carried.records.push(...(snapshot.requestCosts ?? []).map(({ record }) => record));
}
