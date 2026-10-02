import { toTierModelPoolEntries } from '../../services/agent-runtime/model-resolver.js';
import React, { FC } from 'react';
import { useSetting } from '../../hooks/use-setting.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { hasDockerHostControlProject } from '../../utils/shell/sandbox/docker-host-control-grants.js';
import { getProvider } from '../../providers/index.js';
import type { GrokCreditUsage } from '../../providers/grok-credit-usage.js';
import type { OpenCodeGoUsage } from '../../providers/opencode-go-usage.js';
import { getModelContextWindow } from '../../providers/model-catalog/catalog.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { SSHInfo } from '../../services/shell/shell-interaction-session.js';
import type { RunBudgetEvent } from '../../services/agent-runtime/run-budget.js';
import { formatContextUsage, type NormalizedUsage } from '../../utils/ai/token-usage.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
import type { CodexRateLimitInfo, CodexRateLimitWindow } from '../../services/conversation/conversation-events.js';
import type { StaticCommitBlocker } from '../message/MessageList.js';
import { formatUsdMicros, type SessionCostSummary } from '../../services/cost/model-cost.js';
import { getActiveWorkspaceRoot } from '../../services/workspace/active-workspace-root.js';
import { GLYPH_WARNING, type ColorRole } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
import type { StatusAlertView, StatusQuotaWindow, StatusSegmentView, StatusView } from '../../skins/types.js';

function formatStatusBarTokens(tokens: number): string {
  return tokens > 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : tokens.toLocaleString();
}

const PROFILE_MODE_LABELS: Record<string, string> = {
  'builtin:standard': 'Standard',
  'builtin:lite': 'Lite',
  'builtin:plan': 'Plan',
  'builtin:mentor': 'Mentor',
  'builtin:orchestrator': 'Orchestrator',
};

/** Compact rate for the bar (`48.2t/s`); prose contexts keep `formatTokensPerSecond`. */
function formatStatusBarRate(tps: number, approximate: boolean): string {
  return formatTokensPerSecond(tps, approximate).replace(' tok/s', 't/s');
}

/**
 * formatUsdMicros renders every digit below one cent (e.g. $0.008205), which
 * is fine standing alone but too long once it has to share a line with a
 * dozen other numbers. Two significant figures still distinguishes "about a
 * cent" from "about a thousandth of one" — the distinction this line exists
 * to show — so sub-cent amounts get rounded to that before formatting. At or
 * above a cent, formatUsdMicros already renders a fixed two decimals, which
 * is short enough as-is.
 */
const SUBCENT_THRESHOLD_MICROS = 10_000; // one cent, in USD micros
function formatStatusBarCost(usdMicros: number): string {
  if (usdMicros === 0 || Math.abs(usdMicros) >= SUBCENT_THRESHOLD_MICROS) {
    return formatUsdMicros(usdMicros);
  }
  const sign = usdMicros < 0 ? -1 : 1;
  const dollars = Math.abs(usdMicros) / 1_000_000;
  const magnitude = Math.ceil(Math.log10(dollars));
  const scale = 10 ** (2 - magnitude);
  const roundedDollars = Math.round(dollars * scale) / scale;
  return formatUsdMicros(sign * Math.round(roundedDollars * 1_000_000));
}

// Status-bar label per shell auto-approval mode. The raw value 'always' reads
// like a sentence fragment, so the established 'YOLO' term (see
// value-suggestions.ts for 'shell.autoApproveMode') is shown instead.
const AUTO_APPROVE_LABELS: Record<'off' | 'advisory' | 'auto' | 'always', string> = {
  off: '',
  advisory: 'Advisory',
  auto: 'Auto',
  always: 'YOLO',
};

/** One quota window as the classic bar prints it: `5H 42%→09:11`, or `Credits 40%` with no reset. */
export function formatQuotaWindow(window: StatusQuotaWindow): string {
  return `${window.label} ${window.percent}%${window.resetText ? `→${window.resetText}` : ''}`;
}

const formatDateMonthDay = (date: Date): string =>
  `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;

function openCodeGoQuotaWindows(usage: OpenCodeGoUsage | null | undefined): StatusQuotaWindow[] {
  if (!usage) return [];
  const formatReset = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  };
  const toWindow = (label: string, limit: { usagePercent: number; resetInSec: number }): StatusQuotaWindow => ({
    label,
    percent: Math.round(limit.usagePercent),
    resetText: formatReset(limit.resetInSec),
  });
  return [
    toWindow('Roll', usage.rollingUsage),
    toWindow('Week', usage.weeklyUsage),
    toWindow('Month', usage.monthlyUsage),
  ];
}

function codexQuotaWindows(info: CodexRateLimitInfo | null | undefined): StatusQuotaWindow[] {
  if (!info) return [];

  const isNumber = (value: unknown): value is number => typeof value === 'number' && !isNaN(value);

  // Codex decides which slot carries which window, so derive the unit from the
  // window length instead of assuming primary is short and secondary is weekly.
  const formatWindow = (minutes: number): string => {
    if (minutes >= 24 * 60) return `${Math.round(minutes / (24 * 60))}D`;
    if (minutes >= 60) return `${Math.round(minutes / 60)}H`;
    return `${Math.round(minutes)}M`;
  };

  const formatTime = (date: Date): string =>
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  // A reset further out than a day only needs a date. A reset landing within
  // 24h needs the clock time, plus the date when the window itself spans days
  // so it stays clear the reset can be tomorrow rather than later today.
  const formatReset = (resetAt: number, windowMinutes: number): string => {
    const resetDate = new Date(resetAt * 1000);
    const diffMs = resetDate.getTime() - Date.now();
    const within24Hours = diffMs >= 0 && diffMs < 24 * 60 * 60 * 1000;
    if (!within24Hours) {
      return formatDateMonthDay(resetDate);
    }
    return windowMinutes >= 24 * 60
      ? `${formatDateMonthDay(resetDate)} ${formatTime(resetDate)}`
      : formatTime(resetDate);
  };

  const toWindow = (window: CodexRateLimitWindow | undefined): StatusQuotaWindow | undefined => {
    if (!window || !isNumber(window.window_minutes) || !isNumber(window.used_percent) || !isNumber(window.reset_at)) {
      return undefined;
    }
    return {
      label: formatWindow(window.window_minutes),
      percent: window.used_percent,
      resetText: formatReset(window.reset_at, window.window_minutes),
    };
  };

  return [info.primary, info.secondary]
    .map(toWindow)
    .filter((window): window is StatusQuotaWindow => window !== undefined);
}

// Grok reports one weekly credit percentage, not the rolling used/reset
// windows Codex reports, so it gets its own shape in the same slot — only one
// provider is active at a time.
function grokQuotaWindows(usage: GrokCreditUsage | null | undefined): StatusQuotaWindow[] {
  if (!usage || typeof usage.creditUsagePercent !== 'number') return [];
  return [
    {
      label: 'Credits',
      percent: Math.round(usage.creditUsagePercent),
      resetText: usage.periodEndMs === undefined ? undefined : formatDateMonthDay(new Date(usage.periodEndMs)),
    },
  ];
}

function formatActiveTime(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

// In warn mode the run keeps going past its envelope, so this line is the
// only signal the human gets. It states the dimension, used vs limit, and
// percentage consumed, not an instruction — the decision stays with the human.
function runBudgetNoticeText(notice: RunBudgetEvent | null): string {
  if (!notice) return '';
  if (notice.type === 'tool_stall') {
    return `${GLYPH_WARNING} Possible stall: ${notice.toolName} ×${notice.count}`;
  }
  const { dimension, used, limit } = notice.evidence;
  const percent = limit > 0 ? Math.round((used / limit) * 100) : 100;
  switch (dimension) {
    case 'usd':
      return `${GLYPH_WARNING} Run ${formatUsdMicros(used)}/${formatUsdMicros(limit)} (${percent}%)`;
    case 'unpriced_tokens':
      return `${GLYPH_WARNING} Run tokens ${formatStatusBarTokens(used)}/${formatStatusBarTokens(limit)} (${percent}%)`;
    case 'active_time':
      return `${GLYPH_WARNING} Run time ${formatActiveTime(used)}/${formatActiveTime(limit)} (${percent}%)`;
    case 'turns':
      return `${GLYPH_WARNING} Run turns ${used}/${limit} (${percent}%)`;
    default:
      return `${GLYPH_WARNING} Run budget: ${percent}%`;
  }
}

interface StatusBarProps {
  settingsService: SettingsService;
  sshInfo?: SSHInfo;
  lastUsage?: NormalizedUsage | null;
  liveStreamingSpeed?: { tps: number; ttftMs?: number } | null;
  lastCodexRateLimit?: CodexRateLimitInfo | null;
  grokCreditUsage?: GrokCreditUsage | null;
  openCodeGoUsage?: OpenCodeGoUsage | null;
  openRouterUpstream?: string | null;
  upstreamProvider?: string | null;
  largeUncachedWarning?: { estimatedTokens: number } | null;
  hasPendingConfirmation?: boolean;
  pendingLargeUncachedTokens?: number;
  staticCommitBlocker?: StaticCommitBlocker | null;
  queueLength?: number;
  costSummary?: SessionCostSummary | null;
  /** Latest run-budget evidence that did not stop the run (warn mode). */
  runBudgetNotice?: RunBudgetEvent | null;
  /** Deterministic test seam; production uses Ink's stdout width. */
  columns?: number;
}

/**
 * Builds the status view — every number, label and alert, already formatted —
 * and hands it to the active skin to lay out. The formatting and the decisions
 * about what is worth showing live here, so every skin shows the same facts.
 */
const StatusBar: FC<StatusBarProps> = ({
  settingsService,
  sshInfo,
  lastUsage,
  liveStreamingSpeed,
  lastCodexRateLimit,
  grokCreditUsage,
  openCodeGoUsage,
  openRouterUpstream,
  upstreamProvider: upstreamProviderProp,
  largeUncachedWarning,
  hasPendingConfirmation = false,
  pendingLargeUncachedTokens,
  staticCommitBlocker = null,
  queueLength,
  costSummary,
  runBudgetNotice = null,
  columns: testColumns,
}) => {
  const { StatusBar: SkinStatusBar } = useSkin();
  const liveColumns = useTerminalColumns();
  const columns = testColumns ?? liveColumns;

  const activeProfileId = useSetting(settingsService, 'app.activeProfileId') ?? 'builtin:standard';
  const mentorMode = activeProfileId === 'builtin:mentor';
  const model = useSetting(settingsService, 'agent.model');
  const smartPool = useSetting(settingsService, 'agent.smartModel');
  // Display uses the pool's first entry; the pool cursor only advances per
  // subagent spawn.
  const smartModel = toTierModelPoolEntries(smartPool)[0]?.model;
  const legacyMentorModel = useSetting(settingsService, 'agent.mentorModel');
  const mentorModel = smartModel ?? legacyMentorModel;
  const providerKey = useSetting(settingsService, 'agent.provider') ?? 'openai';
  const reasoningEffort = useSetting(settingsService, 'agent.reasoningEffort') ?? 'default';
  const debugMode = useSetting(settingsService, 'logging.logLevel') === 'debug';
  const autoApproveMode = useSetting(settingsService, 'shell.autoApproveMode') ?? 'off';
  const sandboxEnabled = useSetting(settingsService, 'sandbox.enabled') ?? false;
  // Session-scoped grants are intentionally not process-global, so only the
  // persistent project grant is discoverable from this app-wide status bar.
  const dockerHostAccess = hasDockerHostControlProject(getActiveWorkspaceRoot()) ? 'project' : undefined;

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;
  const upstreamProvider = openRouterUpstream ?? upstreamProviderProp ?? lastUsage?.upstream_provider;
  const displayProviderLabel =
    providerKey === 'openrouter' && upstreamProvider ? `${providerLabel} (${upstreamProvider})` : providerLabel;

  // Context gauge: last request's prompt tokens (the current conversation
  // context) over the vendored catalog's context window for the active model.
  // When the context window is absent from the catalog, render the known used
  // context instead of dropping the gauge entirely.
  const contextWindow = model ? getModelContextWindow(providerKey, model) : undefined;
  const contextTokens = lastUsage?.prompt_tokens;
  const contextUsageText = contextTokens != null ? formatContextUsage(contextTokens, contextWindow) : '';
  const contextPercent =
    contextTokens != null && contextWindow ? Math.round((contextTokens / contextWindow) * 100) : undefined;

  const cacheReadTokens = lastUsage?.cache_read_tokens;
  const usageHasCacheRead = cacheReadTokens != null && cacheReadTokens > 0;
  const usageHasIntegratedWarning = Boolean(largeUncachedWarning && usageHasCacheRead);
  const usageTone: ColorRole = largeUncachedWarning ? (hasPendingConfirmation ? 'danger' : 'warning') : 'textSubtle';

  const tokenPieces: string[] = [];
  if (lastUsage?.prompt_tokens != null) tokenPieces.push(`↑${formatStatusBarTokens(lastUsage.prompt_tokens)}`);
  let speedText = '';
  if (lastUsage?.completion_tokens != null) {
    tokenPieces.push(`↓${formatStatusBarTokens(lastUsage.completion_tokens)}`);
    // A burst-inflated settled rate is hidden outright; falling back to the
    // live rate would show a different turn's number.
    const speed = lastUsage.tokens_per_second_burst
      ? undefined
      : lastUsage.tokens_per_second ?? liveStreamingSpeed?.tps;
    if (speed != null && speed > 0) {
      const approximate = lastUsage.tokens_per_second != null && Boolean(lastUsage.tokens_per_second_estimated);
      speedText = `(${formatStatusBarRate(speed, approximate)})`;
    }
  } else if (liveStreamingSpeed?.tps != null && liveStreamingSpeed.tps > 0) {
    speedText = `(${formatStatusBarRate(liveStreamingSpeed.tps, false)})`;
  }
  const tokensText = tokenPieces.join(' ');

  const cachePercent =
    usageHasCacheRead && lastUsage!.prompt_tokens! > 0
      ? Math.round((cacheReadTokens! / lastUsage!.prompt_tokens!) * 100)
      : undefined;
  const cacheText = usageHasIntegratedWarning
    ? `${GLYPH_WARNING} ${formatStatusBarTokens(cacheReadTokens!)} uncached`
    : cachePercent != null
    ? `${cachePercent}% cached`
    : '';

  const contextText = contextUsageText ? `Ctx ${contextUsageText}` : '';
  // The `$` plus slate color identify this as cost, so the segment spends no
  // columns on a `Cost`/`Est` label; `~` marks an estimate, `+` a lower bound.
  const costText =
    costSummary && costSummary.state !== 'unavailable'
      ? `${costSummary.state === 'exact' ? '' : '~'}${formatStatusBarCost(costSummary.knownUsdMicros)}${
          costSummary.state === 'partial' ? '+' : ''
        }`
      : '';

  const warningText = (() => {
    if (!largeUncachedWarning || usageHasIntegratedWarning) {
      return '';
    }
    if (hasPendingConfirmation) {
      const tokens = pendingLargeUncachedTokens ?? largeUncachedWarning.estimatedTokens;
      return `${GLYPH_WARNING} confirm cache miss ~${Math.round(tokens / 1000)}k`;
    }
    return `${GLYPH_WARNING} cache miss risk ~${Math.round(largeUncachedWarning.estimatedTokens / 1000)}k`;
  })();

  // Only one provider is active at a time, so at most one of these is non-empty.
  const codexWindows = codexQuotaWindows(lastCodexRateLimit);
  const grokWindows = grokQuotaWindows(grokCreditUsage);
  const quotaWindows =
    codexWindows.length > 0
      ? codexWindows
      : grokWindows.length > 0
      ? grokWindows
      : openCodeGoQuotaWindows(openCodeGoUsage);
  const quotaText = quotaWindows.map(formatQuotaWindow).join(' / ');

  const staticCommitBlockerText = (() => {
    if (!staticCommitBlocker) {
      return '';
    }

    const sender = staticCommitBlocker.sender ?? 'unknown';
    const status = staticCommitBlocker.status ?? staticCommitBlocker.reason;
    const chars = Math.round(staticCommitBlocker.dynamicTextLength / 1000);
    return `Static blocked ${sender}/${status} ${staticCommitBlocker.dynamicMessageCount}msg/${chars}k`;
  })();

  const profileLabel = PROFILE_MODE_LABELS[String(activeProfileId)] ?? 'Standard';
  // The unlabeled state *is* Standard: absence of a mode word is the signal,
  // so the common case never spends columns restating the default.
  const modeLabel = profileLabel === 'Standard' ? '' : profileLabel;
  // 'always' (YOLO) overrides the sandbox label so YOLO mode is always visible,
  // rendered in red below. When the sandbox is on it still confines commands,
  // but every approval is auto-granted, so the mode must not hide behind
  // 'Sandboxed'.
  const autoApproveAlways = autoApproveMode === 'always';
  const safetyLabel = sandboxEnabled
    ? autoApproveAlways
      ? AUTO_APPROVE_LABELS.always
      : 'Sandboxed'
    : AUTO_APPROVE_LABELS[autoApproveMode];

  const safetyTone: ColorRole = autoApproveAlways
    ? 'danger'
    : sandboxEnabled || autoApproveMode === 'auto'
    ? 'success'
    : 'warning';

  // The alert row is where every non-steady-state message lands. Keeping them
  // in one row (rather than stacked beside the identity segments, as before)
  // means the bar is a single line whenever nothing is wrong — which is most
  // of the time — and grows only to say something.
  const alerts: StatusAlertView[] = [];
  if (warningText) {
    alerts.push({
      id: 'cache-warning',
      parts: [{ text: warningText, tone: hasPendingConfirmation ? 'danger' : 'warning', bold: true }],
    });
  }
  if (dockerHostAccess) {
    alerts.push({
      id: 'docker-host',
      parts: [
        { text: 'Docker host: ', tone: 'textSubtle' },
        { text: dockerHostAccess, tone: 'warning', bold: true },
      ],
    });
  }
  const budgetText = runBudgetNoticeText(runBudgetNotice);
  if (budgetText) {
    alerts.push({ id: 'run-budget', parts: [{ text: budgetText, tone: 'warning', bold: true }] });
  }
  if (debugMode && staticCommitBlockerText) {
    alerts.push({ id: 'static-blocker', parts: [{ text: staticCommitBlockerText, tone: 'danger', bold: true }] });
  }

  // Segments as data: each group is fit to the *full* row budget on its own
  // (drop order below) by the skin, and only afterward are the two fitted groups
  // compared to see whether they still coexist on one line.
  const config: StatusSegmentView[] = [
    { id: 'ssh-marker', text: sshInfo ? 'SSH' : '', tone: 'warning', bold: true, tier: 0 },
    {
      id: 'ssh-detail',
      text: sshInfo ? ` ${sshInfo.user}@${sshInfo.host}:${sshInfo.remoteDir}` : '',
      tone: 'textSubtle',
      tier: 5,
    },
    { id: 'mode', text: modeLabel, tone: 'accent', bold: true, separator: 'group' },
    {
      id: 'queue',
      text: queueLength != null && queueLength > 0 ? `[Q:${queueLength}]` : '',
      tone: 'accent',
      separator: 'group',
      tier: 3,
    },
    { id: 'provider-model', text: model ? `${displayProviderLabel}/${model}` : '', tone: 'accent', separator: 'group' },
    {
      id: 'reasoning',
      text: model && reasoningEffort && reasoningEffort !== 'default' ? ` · ${reasoningEffort}` : '',
      tone: 'warning',
      tier: 2,
    },
    {
      id: 'mentor',
      text: mentorMode && mentorModel ? mentorModel : '',
      tone: 'accentAlt',
      separator: 'group',
      tier: 1,
    },
    { id: 'safety', text: safetyLabel, tone: safetyTone, bold: true, separator: 'group' },
  ];

  const metrics: StatusSegmentView[] = [
    { id: 'tokens', text: tokensText, tone: usageTone, bold: Boolean(largeUncachedWarning), tier: 4 },
    { id: 'speed', text: speedText, tone: 'textSubtle', separator: 'metric', tier: 0 },
    {
      id: 'cache',
      text: cacheText,
      tone: usageHasIntegratedWarning ? usageTone : 'textSubtle',
      bold: usageHasIntegratedWarning ? Boolean(largeUncachedWarning) : false,
      separator: 'metric',
      // The alert variant of this segment is the warning itself, so it must
      // stay on screen for as long as it's showing — dropping it would hide
      // the one thing it exists to say.
      tier: usageHasIntegratedWarning ? undefined : 1,
    },
    { id: 'context', text: contextText, tone: 'textSubtle', separator: 'metric', tier: 3 },
    { id: 'cost', text: costText, tone: 'textSubtle', separator: 'metric', tier: 2 },
  ];

  const view: StatusView = {
    columns,
    config,
    metrics,
    alerts,
    quotaText,
    gauges: {
      contextPercent,
      contextUsedTokens: contextTokens ?? undefined,
      contextWindowTokens: contextWindow ?? undefined,
      cachePercent,
      quotaWindows,
    },
  };

  return <SkinStatusBar {...view} />;
};

export default StatusBar;
