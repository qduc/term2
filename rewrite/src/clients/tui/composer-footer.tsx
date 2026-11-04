import React, { useEffect, useRef, useState } from 'react';
import { formatTokensPerSecond } from './presentation/utils/streaming/streaming-speed-tracker.js';
import { Text } from 'ink';
import { useSkin } from './presentation/skins/SkinContext.js';
import { useTheme } from './presentation/components/theme.js';
import type { MenuHint, StatusSegmentView, StatusView } from './presentation/skins/types.js';
import type { TuiIntegration } from './integration.js';
import type { TuiState } from './state.js';

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

/** Legacy StatusBar's `formatStatusBarTokens`. */
const formatStatusBarTokens = (tokens: number): string =>
  tokens > 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : tokens.toLocaleString();

/** Legacy StatusBar's `formatStatusBarRate` (`48.2t/s`). */
const formatStatusBarRate = (tps: number, approximate: boolean): string =>
  formatTokensPerSecond(tps, approximate).replace(' tok/s', 't/s');

/**
 * The bar the old terminal shows under the composer: profile, provider/model, effort and approval mode, then
 * session token totals and measured provider telemetry when available.
 */
export function directStatusView(
  state: TuiState,
  info: ReturnType<NonNullable<TuiIntegration['status']>>,
  columns: number,
  /** Legacy's liveStreamingSpeed: the rate measured while the current request streams. */
  liveTps?: number | null,
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
  // Legacy StatusBar: every usage figure is the last request's (lastUsage), not a session total.
  const lastUsage = state.lastUsage;
  const contextWindow = info.contextWindow;
  const contextTokens = lastUsage?.inputTokens;
  const contextPercent =
    contextTokens != null && contextWindow ? Math.round((contextTokens / contextWindow) * 100) : undefined;
  const cacheReadTokens = lastUsage?.cachedInputTokens;
  const cachePercent =
    cacheReadTokens != null && cacheReadTokens > 0 && lastUsage!.inputTokens > 0
      ? Math.round((cacheReadTokens / lastUsage!.inputTokens) * 100)
      : undefined;
  const tokenPieces: string[] = [];
  let speedText = '';
  if (lastUsage) {
    tokenPieces.push(
      `↑${formatStatusBarTokens(lastUsage.inputTokens)}`,
      `↓${formatStatusBarTokens(lastUsage.outputTokens)}`,
    );
    const speed = state.speed?.tps ?? liveTps ?? undefined;
    if (speed != null && speed > 0)
      speedText = `(${formatStatusBarRate(speed, state.speed != null && state.speed.approximate)})`;
  } else if (liveTps != null && liveTps > 0) {
    speedText = `(${formatStatusBarRate(liveTps, false)})`;
  }
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
    { id: 'tokens', text: tokenPieces.join(' '), tone: 'textSubtle', bold: false, tier: 4 },
    { id: 'speed', text: speedText, tone: 'textSubtle', separator: 'metric', tier: 0 },
    {
      id: 'cache',
      text: cachePercent != null ? `${cachePercent}% cached` : '',
      tone: 'textSubtle',
      bold: false,
      separator: 'metric',
      tier: 1,
    },
    {
      id: 'context',
      text: contextTokens != null ? `Ctx ${formatContextUsage(contextTokens, contextWindow)}` : '',
      tone: 'textSubtle',
      separator: 'metric',
      tier: 3,
    },
  ];
  return {
    columns,
    config,
    metrics,
    alerts: [],
    quotaText: quotaWindows.map((window) => `${window.label} ${window.percent}%→${window.resetText}`).join(' / '),
    gauges: {
      contextPercent,
      contextUsedTokens: contextTokens,
      contextWindowTokens: contextWindow,
      cachePercent,
      quotaWindows,
    },
  };
}

/**
 * Legacy's footer keeps the last request's usage until the conversation is cleared (a new session, so a fresh
 * mount here): a model switch, rewind or compaction does not blank it, though the snapshot drops it.
 */
export function useFooterUsage(state: TuiState, resumed = false): TuiState {
  const kept = useRef<Pick<TuiState, 'lastUsage' | 'speed'>>({});
  // Legacy's in-app /resume (restoreConversation) puts the restored session's cumulative usage in the footer
  // until the next request reports its own.
  const restored = useRef(resumed ? JSON.stringify(state.lastUsage ?? null) : null);
  if (restored.current !== null && restored.current !== JSON.stringify(state.lastUsage ?? null))
    restored.current = null;
  const total = state.sessionUsage;
  if (restored.current !== null && total && (total.inputTokens || total.outputTokens || total.cachedInputTokens)) {
    const { speed: _speed, ...rest } = state;
    return { ...rest, lastUsage: total };
  }
  if (state.lastUsage) kept.current = { lastUsage: state.lastUsage, speed: state.speed };
  return state.lastUsage ? state : { ...state, ...kept.current };
}

/**
 * Legacy InputBox's useTerminalWidth: the editor's width starts at 0 each time the input surface mounts (after a
 * menu closes, say) and is set by an effect. A restored draft is drawn one character per line for that first
 * frame, which at a small terminal makes Ink take its full-redraw path, as legacy does.
 */
export function ComposerWidth({
  columns,
  children,
}: {
  readonly columns: number;
  readonly children: (width: number) => React.ReactNode;
}): React.ReactElement {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <>{children(mounted ? Math.max(1, columns - 6) : 0)}</>;
}

/** Everything below the composer: its key hints while it is active, and the status bar always. */
export function ComposerFooter({
  integration,
  state,
  liveTps,
  active,
  draftEmpty,
  escHint,
  columns,
  queueSelectable,
}: {
  readonly integration: TuiIntegration;
  readonly state: TuiState;
  readonly liveTps?: number | null;
  readonly active: boolean;
  readonly draftEmpty: boolean;
  /** Legacy InputBox: after one Escape the hint replaces the shortcuts until a second clears the draft. */
  readonly escHint: boolean;
  readonly columns: number;
  readonly queueSelectable: boolean;
}): React.ReactElement {
  const { Hints, StatusBar } = useSkin();
  const theme = useTheme();
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
      {active && escHint ? <Text color={theme.textSubtle}>Press Esc again to clear input</Text> : null}
      {active && !escHint ? (
        <ComposerHints
          activeTurn={Boolean(state.activeTurnId)}
          draftEmpty={draftEmpty}
          queued={queueSelectable}
          Hints={Hints}
        />
      ) : null}
      {info ? <StatusBar {...directStatusView(state, info, columns, liveTps)} /> : null}
    </>
  );
}

/** Legacy InputBox's footer hints (source/components/InputBox.tsx), with their key colours. */
const MODEL_HINTS: ReadonlyArray<MenuHint> = [
  ['Ctrl+O', 'model'],
  ['Ctrl+T', 'effort'],
];
const IDLE_HINTS: ReadonlyArray<MenuHint> = [
  ['/', 'commands'],
  ['@', 'paths'],
  ['!', 'shell'],
  ['Shift+Tab', 'plan'],
];
const TURN_IN_FLIGHT_HINTS: ReadonlyArray<MenuHint> = [
  ['⏎', 'steer', 'accent'],
  ['Alt+⏎', 'queue', 'accentAlt'],
  ...MODEL_HINTS,
];

/**
 * Composer shortcuts are shown only when the composer owns input: idle hints only for an empty draft, and the
 * steer/queue hints during a turn, led by the queue hint when messages are queued and the draft is empty.
 */
function ComposerHints({
  activeTurn,
  draftEmpty,
  queued,
  Hints,
}: {
  readonly activeTurn: boolean;
  readonly draftEmpty: boolean;
  readonly queued: boolean;
  readonly Hints: React.ComponentType<{ hints: ReadonlyArray<MenuHint> }>;
}): React.ReactElement | null {
  if (activeTurn)
    return (
      <Hints hints={queued && draftEmpty ? [['↑', 'select queued'], ...TURN_IN_FLIGHT_HINTS] : TURN_IN_FLIGHT_HINTS} />
    );
  return draftEmpty ? <Hints hints={IDLE_HINTS} /> : null;
}
