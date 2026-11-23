'use client';

import { useEffect, useRef, useState } from 'react';
import { Archive, Gauge } from 'lucide-react';
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
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Session usage and context"
        title="View token usage, context window, and cost"
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11.5px] tabular-nums text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
      >
        <Gauge aria-hidden className="h-3.5 w-3.5" />
        <span>
          {totalTokens > 0 ? `${formatCompact(totalTokens)} tok` : 'Usage'}
          {contextRatio !== null ? ` · ${Math.round(contextRatio * 100)}%` : ''}
          {knownUsd !== null ? ` · $${knownUsd < 0.01 ? knownUsd.toFixed(4) : knownUsd.toFixed(2)}` : ''}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Usage and context details"
          className="t2-enter absolute bottom-full right-0 z-40 mb-2 w-72 rounded-2xl border border-black/[0.09] bg-white p-3.5 text-xs shadow-[0_16px_40px_-10px_rgba(0,0,0,0.2)] dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_16px_40px_-10px_rgba(0,0,0,0.65)]"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Session usage</h3>
            {config && <span className="font-mono text-[10.5px] text-zinc-400">{config.modelId}</span>}
          </div>

          {contextWindow && (
            <div className="mt-3">
              <div className="flex justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
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

          <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-[11.5px]">
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
            <p className="mt-2 text-[10.5px] leading-4 text-zinc-400 dark:text-zinc-500">
              Based on {receiptSummary.pricedRequests} priced
              {receiptSummary.unpricedRequests > 0 ? ` and ${receiptSummary.unpricedRequests} unpriced` : ''} observed
              request{receiptSummary.pricedRequests === 1 ? '' : 's'} ({receiptSummary.state}). Historical coverage is
              unknown; not a complete session bill.
            </p>
          )}

          {canCompact && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCompact();
              }}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-black/[0.08] px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/[0.06]"
            >
              <Archive className="h-3.5 w-3.5" />
              Compact context to free space
            </button>
          )}
        </div>
      )}
    </div>
  );
}
