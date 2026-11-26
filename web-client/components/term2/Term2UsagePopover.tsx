'use client';

import { useEffect, useState } from 'react';
import { Archive, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { term2Client } from '../../lib/api/term2';
import { summarizeReceiptCosts } from '../../lib/term2/receipt-cost';
import type {
  ModelSummary,
  SessionConfigRecord,
  SessionQuota,
  SubscriptionQuotaWindow,
  Term2SessionView,
} from '../../lib/term2/types';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** "3:40 PM" today, else "Thu 3:40 PM". */
function formatReset(resetAt: number): string {
  const date = new Date(resetAt * 1000);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/**
 * The session's subscription allowance. The wire carries no quota change, so it is reread whenever
 * `refresh` changes: the provider reports it with every model response, including each step of a
 * tool loop, not only when the turn ends.
 */
function useSessionQuota(sessionId: string, refresh: string): SessionQuota | null {
  const [quota, setQuota] = useState<{ sessionId: string; value: SessionQuota } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    term2Client
      .readSessionQuota(sessionId, controller.signal)
      .then((value) => setQuota({ sessionId, value }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [sessionId, refresh]);
  return quota?.sessionId === sessionId ? quota.value : null;
}

const QUOTA_WINDOWS = [
  { key: 'fiveHour', label: '5-hour limit', short: '5h' },
  { key: 'weekly', label: 'Weekly limit', short: 'week' },
] as const;

function liveWindows(quota: SessionQuota | null) {
  const now = Date.now() / 1000;
  return QUOTA_WINDOWS.flatMap(({ key, label, short }) => {
    const window: SubscriptionQuotaWindow | null = quota?.windows[key] ?? null;
    return window && window.resetAt > now ? [{ key, label, short, ...window }] : [];
  });
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

  const allTurns = view.turns;
  // The session's own totals and the latest request's input (context fill), not sums of per-reply counts.
  const sessionUsage = view.session?.usage;
  const lastTurnInput = view.session?.lastUsage?.inputTokens ?? 0;
  const totalInput = sessionUsage?.inputTokens ?? 0;
  const totalOutput = sessionUsage?.outputTokens ?? 0;
  const totalCached = sessionUsage?.cachedInputTokens ?? 0;
  const totalTokens = totalInput + totalOutput;

  const modelMeta = config ? models.find((m) => m.provider === config.providerId && m.id === config.modelId) : undefined;
  const contextWindow = modelMeta?.contextWindow;
  const contextRatio = contextWindow && lastTurnInput > 0 ? Math.min(1, lastTurnInput / contextWindow) : null;
  const receiptSummary = summarizeReceiptCosts(view.session?.requestCosts);
  const hasCost = Boolean(receiptSummary && receiptSummary.pricedRequests > 0);
  const knownUsd = hasCost && receiptSummary ? receiptSummary.knownUsdMicros / 1_000_000 : null;

  // One step per model response seen: a finished turn, or a tool call a response asked for.
  const responses = allTurns.reduce(
    (count, turn) => count + turn.commands.length + (turn.status !== 'streaming' && turn.status !== 'pending' ? 1 : 0),
    0,
  );
  const model = config ? `${config.providerId}/${config.modelId}` : '';
  // Opening the popover rereads too, so what it shows is never older than the click.
  const quota = useSessionQuota(view.sessionId, `${responses}:${model}:${open ? 'open' : ''}`);
  const windows = liveWindows(quota);
  const subscription = quota?.subscription === true;
  // The pill names the tightest window: the one closest to running out.
  const tightest = windows.reduce<(typeof windows)[number] | null>(
    (worst, window) => (!worst || window.usedPercent > worst.usedPercent ? window : worst),
    null,
  );

  if (totalTokens === 0 && !hasCost && !contextWindow && windows.length === 0) return null;

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
            {tightest ? ` · ${tightest.short} ${Math.round(tightest.usedPercent)}%` : ''}
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
              {knownUsd !== null ? `$${knownUsd.toFixed(4)} USD` : subscription ? 'Included in plan' : 'Unavailable'}
            </dd>
          </dl>

          {(windows.length > 0 || subscription) && (
            <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              <h4 className="font-medium text-zinc-700 dark:text-zinc-300">Plan usage</h4>
              {windows.length === 0 && (
                <p className="mt-1 leading-4 text-zinc-400 dark:text-zinc-500">
                  {quota?.provider === 'codex'
                    ? 'Codex reports its limits with each response; they appear after the next one.'
                    : 'This provider does not report its plan limits to term2.'}
                </p>
              )}
              {windows.map((window) => (
                <div key={window.key} className="mt-2">
                  <div className="flex justify-between text-zinc-500 dark:text-zinc-400">
                    <span>{window.label}</span>
                    <span className="tabular-nums">
                      {Math.round(window.usedPercent)}% · resets {formatReset(window.resetAt)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className={`h-full rounded-full ${window.usedPercent > 80 ? 'bg-amber-500' : 'bg-teal-500'}`}
                      style={{ width: `${Math.max(window.usedPercent > 0 ? 3 : 0, Math.round(window.usedPercent))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
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
