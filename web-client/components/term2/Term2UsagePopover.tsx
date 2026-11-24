'use client';

import { useState } from 'react';
import { Archive, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { summarizeReceiptCosts } from '../../lib/term2/receipt-cost';
import type { ModelSummary, SessionConfigRecord, Term2SessionView } from '../../lib/term2/types';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function Term2UsagePopover({
  view,
  config,
  models,
  canCompact,
  onCompact,
}: {
  view: Term2SessionView;
  config: SessionConfigRecord | null;
  models: ModelSummary[];
  canCompact: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);

  const allTurns = [...(view.retiredTurns ?? []), ...view.turns];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let lastTurnInput = 0;
  for (const turn of allTurns) {
    if (!turn.usage) continue;
    const usage = turn.usage as {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
    };
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cachedTokens += usage.cachedInputTokens ?? 0;
    if (usage.inputTokens) lastTurnInput = usage.inputTokens;
  }
  const snapUsage = view.hydration?.snapshot.usage as
    | { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
    | undefined;
  const totalInput = Math.max(inputTokens, snapUsage?.inputTokens ?? 0);
  const totalOutput = Math.max(outputTokens, snapUsage?.outputTokens ?? 0);
  const totalCached = Math.max(cachedTokens, snapUsage?.cachedInputTokens ?? 0);
  const totalTokens = totalInput + totalOutput;

  const modelMeta = config ? models.find((m) => m.provider === config.providerId && m.id === config.modelId) : undefined;
  const contextWindow = modelMeta?.contextWindow;
  const contextRatio = contextWindow && lastTurnInput > 0 ? Math.min(1, lastTurnInput / contextWindow) : null;
  const receiptSummary = summarizeReceiptCosts(view.nativeState?.requestCosts);
  const hasCost = Boolean(receiptSummary && receiptSummary.pricedRequests > 0);
  const knownUsd = hasCost && receiptSummary ? receiptSummary.knownUsdMicros / 1_000_000 : null;

  if (totalTokens === 0 && !hasCost && !contextWindow) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="Session usage and context"
          title="View token usage, context window, and cost"
          className="rounded-full tabular-nums text-muted-foreground"
        >
          <Gauge aria-hidden />
          <span>
            {totalTokens > 0 ? `${formatCompact(totalTokens)} tok` : 'Usage'}
            {contextRatio !== null ? ` · ${Math.round(contextRatio * 100)}%` : ''}
            {knownUsd !== null ? ` · $${knownUsd < 0.01 ? knownUsd.toFixed(4) : knownUsd.toFixed(2)}` : ''}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="Usage and context details" className="block w-72 text-xs">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Session usage</h3>
            {config && <span className="font-mono text-xs text-zinc-400">{config.modelId}</span>}
          </div>

          {contextWindow && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
                <span>Context window</span>
                <span className="tabular-nums">
                  {lastTurnInput > 0 ? `${formatCompact(lastTurnInput)} / ` : ''}
                  {formatCompact(contextWindow)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className={`h-full rounded-full transition-all ${
                    (contextRatio ?? 0) > 0.8
                      ? 'bg-amber-500'
                      : 'bg-teal-500'
                  }`}
                  style={{ width: `${Math.max(contextRatio ? 3 : 0, Math.round((contextRatio ?? 0) * 100))}%` }}
                />
              </div>
            </div>
          )}

          <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-xs">
            <dt className="text-zinc-500 dark:text-zinc-400">Input tokens</dt>
            <dd className="text-right font-medium tabular-nums text-zinc-800 dark:text-zinc-200">
              {totalInput.toLocaleString()}
            </dd>
            {totalCached > 0 && (
              <>
                <dt className="text-zinc-500 dark:text-zinc-400">Cached input</dt>
                <dd className="text-right font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                  {totalCached.toLocaleString()} ({totalInput > 0 ? Math.round((totalCached / totalInput) * 100) : 0}%)
                </dd>
              </>
            )}
            <dt className="text-zinc-500 dark:text-zinc-400">Output tokens</dt>
            <dd className="text-right font-medium tabular-nums text-zinc-800 dark:text-zinc-200">
              {totalOutput.toLocaleString()}
            </dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Observed cost</dt>
            <dd className="text-right font-medium tabular-nums text-zinc-800 dark:text-zinc-200">
              {knownUsd !== null ? `$${knownUsd.toFixed(4)} USD` : 'Unavailable'}
            </dd>
          </dl>

          {receiptSummary && (
            <p className="mt-2 text-xs leading-4 text-zinc-400 dark:text-zinc-500">
              Based on {receiptSummary.pricedRequests} priced
              {receiptSummary.unpricedRequests > 0 ? ` and ${receiptSummary.unpricedRequests} unpriced` : ''} observed
              request{receiptSummary.pricedRequests === 1 ? '' : 's'} ({receiptSummary.state}). Historical coverage is
              unknown; not a complete session bill.
            </p>
          )}

          {canCompact && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                onCompact();
              }}
              className="mt-3 w-full"
            >
              <Archive />
              Compact context to free space
            </Button>
          )}
      </PopoverContent>
    </Popover>
  );
}
