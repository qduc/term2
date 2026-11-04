import React, { useEffect, useState } from 'react';
import { formatTokensPerSecond } from './presentation/utils/streaming/streaming-speed-tracker.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import type { StatusSegmentView, StatusView } from './presentation/skins/types.js';
import type { TuiIntegration } from './integration.js';
import type { TuiState } from './state.js';
import { ComposerHints } from './slash-menu.js';

function formatCompactTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1_000)}k`;
}

/**
 * Compact context gauge, e.g. "100k/1.0M": tokens used in the current context
 * (the last request's prompt tokens) over the model's context window.
 * When the context window is unknown, returns only the used token gauge (e.g. "100k").
 */
export function formatContextUsage(usedTokens: number, contextWindow?: number): string {
  if (contextWindow == null) {
    return formatCompactTokens(usedTokens);
  }
  return `${formatCompactTokens(usedTokens)}/${formatCompactTokens(contextWindow)}`;
}

const APPROVAL_LABEL = { off: '', advisory: 'Advisory', auto: 'Auto', always: 'YOLO' } as const;

const tokens = (count: number): string => (count > 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count));

/**
 * The bar the old terminal shows under the composer: profile, provider/model, effort and approval mode, then
 * session token totals and measured provider telemetry when available.
 */
export function directStatusView(
  state: TuiState,
  info: ReturnType<NonNullable<TuiIntegration['status']>>,
  columns: number,
): StatusView {
  const quota = state.codexQuota && state.codexQuota.resetAt * 1000 > Date.now() ? state.codexQuota : undefined;
  const reset = quota ? new Date(quota.resetAt * 1000) : undefined;
  const resetDate = reset
    ? `${String(reset.getMonth() + 1).padStart(2, '0')}/${String(reset.getDate()).padStart(2, '0')}`
    : '';
  const resetText =
    reset && reset.getTime() - Date.now() < 86400000
      ? `${resetDate} ${reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : resetDate;
  const quotaWindows = quota ? [{ label: '7D', percent: quota.usedPercent, resetText }] : [];
  const totals = state.usageTotals;
  const cached =
    totals && totals.inputTokens > 0 ? Math.round((totals.cachedInputTokens / totals.inputTokens) * 100) : undefined;
  const used = state.contextUsedTokens;
  const window = info.contextWindow;
  const config: StatusSegmentView[] = [
    { id: 'mode', text: info.profile, tone: 'accent', bold: true, separator: 'group' },
    {
      id: 'queue',
      text: state.queue.some((item) => item.delivery === 'queued')
        ? `[Q:${state.queue.filter((item) => item.delivery === 'queued').length}]`
        : '',
      tone: 'accent',
      separator: 'group',
      tier: 3,
    },
    { id: 'provider-model', text: state.model, tone: 'accent', separator: 'group' },
    {
      id: 'reasoning',
      text: info.effort && info.effort !== 'default' ? ` · ${info.effort}` : '',
      tone: 'warning',
      tier: 2,
    },
    {
      id: 'safety',
      text: APPROVAL_LABEL[info.approval],
      tone: info.approval === 'always' ? 'danger' : info.approval === 'auto' ? 'success' : 'warning',
      bold: true,
      separator: 'group',
    },
  ];
  const metrics: StatusSegmentView[] = [
    {
      id: 'tokens',
      text:
        totals && totals.inputTokens + totals.outputTokens > 0
          ? `↑${tokens(totals.inputTokens)} ↓${tokens(totals.outputTokens)}`
          : '',
      tone: 'textSubtle',
      tier: 4,
    },
    {
      id: 'speed',
      text: state.speed ? formatTokensPerSecond(state.speed.tps, state.speed.approximate).replace(' tok/s', 't/s') : '',
      tone: 'textSubtle',
      separator: 'metric',
      tier: 0,
    },
    {
      id: 'cache',
      text: cached === undefined ? '' : `${cached}% cached`,
      tone: 'textSubtle',
      separator: 'metric',
      tier: 1,
    },
    {
      id: 'context',
      text: used === undefined ? '' : `Ctx last ${formatContextUsage(used, window)}`,
      tone: 'textSubtle',
      separator: 'metric',
      tier: 1,
    },
  ];
  return {
    columns,
    config,
    metrics,
    alerts: [],
    quotaText: quotaWindows.map((window) => `${window.label} ${window.percent}%→${window.resetText}`).join(' / '),
    gauges: {
      contextPercent: undefined,
      contextUsedTokens: undefined,
      contextWindowTokens: undefined,
      cachePercent: cached,
      quotaWindows,
    },
  };
}

/** Everything below the composer: its key hints while it is active, and the status bar always. */
export function ComposerFooter({
  integration,
  state,
  active,
  columns,
  queueSelectable,
}: {
  readonly integration: TuiIntegration;
  readonly state: TuiState;
  readonly active: boolean;
  readonly columns: number;
  readonly queueSelectable: boolean;
}): React.ReactElement {
  const { Hints, StatusBar } = useSkin();
  const [, setQuotaClock] = useState(0);
  useEffect(() => {
    if (!state.codexQuota) return;
    const delay = state.codexQuota.resetAt * 1000 - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setQuotaClock((value) => value + 1), Math.min(delay + 1, 2147483647));
    return () => clearTimeout(timer);
  }, [state.codexQuota]);
  const info = integration.status?.(state.sessionId);
  return (
    <>
      {active ? (
        <ComposerHints
          activeTurn={Boolean(state.activeTurnId)}
          queueSelectable={queueSelectable}
          columns={columns}
          Hints={Hints}
        />
      ) : null}
      {info ? <StatusBar {...directStatusView(state, info, columns)} /> : null}
    </>
  );
}
