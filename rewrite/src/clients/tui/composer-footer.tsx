import React from 'react';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { StatusSegmentView, StatusView } from '../../../../source/skins/types.js';
import type { TuiIntegration } from './integration.js';
import type { TuiState } from './state.js';
import { ComposerHints } from './slash-menu.js';

const APPROVAL_LABEL = { off: '', advisory: 'Advisory', auto: 'Auto', always: 'YOLO' } as const;

const tokens = (count: number): string => (count > 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count));

/**
 * The bar the old terminal shows under the composer: profile, provider/model, effort and approval mode, then
 * session token totals. Only data the direct wire or settings carry is shown; there is no speed, context
 * window or quota here, because the direct snapshot has no per-request usage or provider quota.
 */
export function directStatusView(
  state: TuiState,
  info: ReturnType<NonNullable<TuiIntegration['status']>>,
  columns: number,
): StatusView {
  const totals = state.usageTotals;
  const cached =
    totals && totals.inputTokens > 0 ? Math.round((totals.cachedInputTokens / totals.inputTokens) * 100) : undefined;
  const config: StatusSegmentView[] = [
    { id: 'mode', text: info.profile, tone: 'accent', bold: true, separator: 'group' },
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
      id: 'cache',
      text: cached === undefined ? '' : `${cached}% cached`,
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
    quotaText: '',
    gauges: {
      contextPercent: undefined,
      contextUsedTokens: undefined,
      contextWindowTokens: undefined,
      cachePercent: cached,
      quotaWindows: [],
    },
  };
}

/** Everything below the composer: its key hints while it is active, and the status bar always. */
export function ComposerFooter({
  integration,
  state,
  active,
  columns,
}: {
  readonly integration: TuiIntegration;
  readonly state: TuiState;
  readonly active: boolean;
  readonly columns: number;
}): React.ReactElement {
  const { Hints, StatusBar } = useSkin();
  const info = integration.status?.(state.sessionId);
  return (
    <>
      {active ? <ComposerHints activeTurn={Boolean(state.activeTurnId)} Hints={Hints} /> : null}
      {info ? <StatusBar {...directStatusView(state, info, columns)} /> : null}
    </>
  );
}
