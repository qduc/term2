import React, { FC } from 'react';
import { Box, Text } from 'ink';
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
import type { CodexRateLimitInfo, CodexRateLimitWindow } from '../../services/conversation/conversation-events.js';
import type { StaticCommitBlocker } from '../message/MessageList.js';
import { formatUsdMicros, type SessionCostSummary } from '../../services/cost/model-cost.js';
import { getActiveWorkspaceRoot } from '../../services/workspace/active-workspace-root.js';
import { terminalTextWidth, truncateTerminalText } from './terminal-text-budget.js';
import {
  COLOR_ACCENT,
  COLOR_ACCENT_ALT,
  COLOR_DANGER,
  COLOR_SUCCESS,
  COLOR_TEXT_SUBTLE,
  COLOR_WARNING,
  GLYPH_SELECTED,
  GLYPH_SEPARATOR,
  GLYPH_WARNING,
} from '../theme.js';

/**
 * The one separator used between top-level config segments. Spacing lives
 * here so every gap is identical; previously the same `│` was written three
 * different ways (bare, inside `marginX`, and padded) and the bar looked
 * ragged.
 */
const Divider: FC = () => <Text color={COLOR_TEXT_SUBTLE}> {GLYPH_SEPARATOR} </Text>;

/** The separator used between metrics segments — a lighter join than the `│`
 * used elsewhere, since the metrics group is already one visual cluster. */
const MetricDivider: FC = () => <Text color={COLOR_TEXT_SUBTLE}> · </Text>;

function formatStatusBarTokens(tokens: number): string {
  return tokens > 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : tokens.toLocaleString();
}

// terminalTextWidth counts every codepoint above U+007F as 2 columns, which is
// the right conservative default for CJK/emoji text but wildly overcounts the
// narrow box-drawing and arrow glyphs this bar is built from (│ ↑ ↓ · ▲ ❯ …).
// Measuring those as 2 nearly doubles the bar's apparent width and makes the
// budget collapse into the narrow layout far too eagerly. These specific
// glyphs render as exactly one cell in every terminal this app targets (they
// are chosen from theme.ts's "single-width on purpose" set plus the ellipsis
// truncateTerminalText appends), so measure them at 1 and defer to
// terminalTextWidth for everything else. Fix it here, not in
// terminalTextWidth itself — other callers of that function rely on its
// conservative doubling for content that really can be double-width.
const STATUS_BAR_NARROW_GLYPHS = new Set([GLYPH_SEPARATOR, '↑', '↓', '·', GLYPH_WARNING, GLYPH_SELECTED, '…']);

function statusBarTextWidth(value: string): number {
  return Array.from(value).reduce(
    (columns, char) => columns + (STATUS_BAR_NARROW_GLYPHS.has(char) ? 1 : terminalTextWidth(char)),
    0,
  );
}

const GROUP_SEPARATOR_TEXT = ` ${GLYPH_SEPARATOR} `;
const METRIC_SEPARATOR_TEXT = ' · ';
const GROUP_SEPARATOR_WIDTH = statusBarTextWidth(GROUP_SEPARATOR_TEXT);
const METRIC_SEPARATOR_WIDTH = statusBarTextWidth(METRIC_SEPARATOR_TEXT);

type SeparatorKind = 'group' | 'metric';

/** One piece of the status bar, as data rather than inline JSX, so a shared
 * layout routine can measure, drop, and truncate segments identically for
 * both the configuration group and the metrics group. */
interface StatusSegment {
  id: string;
  /** Empty string means "not applicable right now" and is filtered out before layout. */
  text: string;
  color?: string;
  bold?: boolean;
  /** Divider drawn before this segment when an earlier segment in the same
   * group is visible. Omitted for sub-segments (e.g. reasoning effort, the
   * SSH host detail) that attach directly to the segment before them instead
   * of getting their own divider. */
  separator?: SeparatorKind;
  /** Drop order: lower drops first. Omit to make a segment undroppable. */
  tier?: number;
}

interface RenderedSegment {
  id: string;
  text: string;
  color?: string;
  bold?: boolean;
  showSeparator: boolean;
  separator?: SeparatorKind;
}

function separatorWidth(kind: SeparatorKind | undefined): number {
  if (kind === 'group') return GROUP_SEPARATOR_WIDTH;
  if (kind === 'metric') return METRIC_SEPARATOR_WIDTH;
  return 0;
}

function computeVisible(segments: StatusSegment[], dropped: ReadonlySet<string>): RenderedSegment[] {
  const visible: RenderedSegment[] = [];
  let anyBefore = false;
  for (const segment of segments) {
    if (!segment.text || dropped.has(segment.id)) continue;
    visible.push({
      id: segment.id,
      text: segment.text,
      color: segment.color,
      bold: segment.bold,
      showSeparator: Boolean(segment.separator) && anyBefore,
      separator: segment.separator,
    });
    anyBefore = true;
  }
  return visible;
}

function measureVisible(visible: RenderedSegment[]): number {
  return visible.reduce(
    (total, segment) =>
      total + (segment.showSeparator ? separatorWidth(segment.separator) : 0) + statusBarTextWidth(segment.text),
    0,
  );
}

/**
 * Fits one segment group to `budget` physical columns by dropping whole
 * segments in ascending `tier` order (lowest tier first) until it fits, then —
 * only as a last resort, and only for `truncatableId` — shrinking that one
 * segment's text with an ellipsis. This is the explicit-budget approach
 * BackgroundTasksPanel already uses: compute a hard column budget and shed
 * content deliberately, rather than let Ink's flexbox reflow text mid-word
 * when nothing fits.
 */
function fitGroup(
  defs: StatusSegment[],
  budget: number,
  truncatableId?: string,
): { visible: RenderedSegment[]; width: number } {
  const present = defs.filter((segment) => segment.text);
  const dropped = new Set<string>();
  const dropOrder = present
    .filter((segment) => segment.tier != null)
    .sort((a, b) => a.tier! - b.tier!)
    .map((segment) => segment.id);

  let visible = computeVisible(present, dropped);
  let width = measureVisible(visible);

  for (const id of dropOrder) {
    if (width <= budget) break;
    dropped.add(id);
    visible = computeVisible(present, dropped);
    width = measureVisible(visible);
  }

  if (width > budget && truncatableId) {
    const index = visible.findIndex((segment) => segment.id === truncatableId);
    if (index !== -1) {
      const segment = visible[index];
      const ownWidth =
        (segment.showSeparator ? separatorWidth(segment.separator) : 0) + statusBarTextWidth(segment.text);
      const otherWidth = width - ownWidth;
      const separatorPortion = segment.showSeparator ? separatorWidth(segment.separator) : 0;
      const textAllowance = Math.max(1, budget - otherWidth - separatorPortion);
      const truncated = truncateTerminalText(segment.text, textAllowance);
      visible = visible.map((entry, entryIndex) => (entryIndex === index ? { ...entry, text: truncated } : entry));
      width = measureVisible(visible);
    }
  }

  return { visible, width };
}

function renderSegments(visible: RenderedSegment[]) {
  return visible.map((segment) => (
    <React.Fragment key={segment.id}>
      {segment.showSeparator && (segment.separator === 'metric' ? <MetricDivider /> : <Divider />)}
      <Text color={segment.color} bold={segment.bold} wrap="truncate-end">
        {segment.text}
      </Text>
    </React.Fragment>
  ));
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

interface StatusBarProps {
  settingsService: SettingsService;
  sshInfo?: SSHInfo;
  lastUsage?: NormalizedUsage | null;
  lastCodexRateLimit?: CodexRateLimitInfo | null;
  grokCreditUsage?: GrokCreditUsage | null;
  openCodeGoUsage?: OpenCodeGoUsage | null;
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

const StatusBar: FC<StatusBarProps> = ({
  settingsService,
  sshInfo,
  lastUsage,
  lastCodexRateLimit,
  grokCreditUsage,
  openCodeGoUsage,
  largeUncachedWarning,
  hasPendingConfirmation = false,
  pendingLargeUncachedTokens,
  staticCommitBlocker = null,
  queueLength,
  costSummary,
  runBudgetNotice = null,
  columns: testColumns,
}) => {
  const liveColumns = useTerminalColumns();
  const columns = testColumns ?? liveColumns;
  // The bar applies paddingX={1} on both sides, so the budget available to
  // segments is narrower than the terminal itself.
  const budget = Math.max(1, columns - 2);

  const mentorMode = useSetting(settingsService, 'app.mentorMode') ?? false;
  const liteMode = useSetting(settingsService, 'app.liteMode') ?? false;
  const planMode = useSetting(settingsService, 'app.planMode') ?? false;
  const orchestratorMode = useSetting(settingsService, 'app.orchestratorMode') ?? false;
  const model = useSetting(settingsService, 'agent.model');
  const smartModel = useSetting(settingsService, 'agent.smartModel');
  const legacyMentorModel = useSetting(settingsService, 'agent.mentorModel');
  const mentorModel = smartModel ?? legacyMentorModel;
  const providerKey = useSetting(settingsService, 'agent.provider') ?? 'openai';
  const reasoningEffort = useSetting(settingsService, 'agent.reasoningEffort') ?? 'default';
  const autoApproveMode = useSetting(settingsService, 'shell.autoApproveMode') ?? 'off';
  const sandboxEnabled = useSetting(settingsService, 'sandbox.enabled') ?? false;
  // Session-scoped grants are intentionally not process-global, so only the
  // persistent project grant is discoverable from this app-wide status bar.
  const dockerHostAccess = hasDockerHostControlProject(getActiveWorkspaceRoot()) ? 'project' : undefined;

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;

  // Context gauge: last request's prompt tokens (the current conversation
  // context) over the vendored catalog's context window for the active model.
  // When the context window is absent from the catalog, render the known used
  // context instead of dropping the gauge entirely.
  const contextWindow = model ? getModelContextWindow(providerKey, model) : undefined;
  const contextTokens = lastUsage?.prompt_tokens;
  const contextUsageText = contextTokens != null ? formatContextUsage(contextTokens, contextWindow) : '';

  const slate = COLOR_TEXT_SUBTLE;
  const glow = COLOR_WARNING;
  const accent = COLOR_ACCENT;
  const warnRed = COLOR_DANGER;

  const cacheReadTokens = lastUsage?.cache_read_tokens;
  const usageHasCacheRead = cacheReadTokens != null && cacheReadTokens > 0;
  const usageHasIntegratedWarning = Boolean(largeUncachedWarning && usageHasCacheRead);
  const usageColor = largeUncachedWarning ? (hasPendingConfirmation ? warnRed : glow) : slate;

  const tokenPieces: string[] = [];
  if (lastUsage?.prompt_tokens != null) tokenPieces.push(`↑${formatStatusBarTokens(lastUsage.prompt_tokens)}`);
  if (lastUsage?.completion_tokens != null) tokenPieces.push(`↓${formatStatusBarTokens(lastUsage.completion_tokens)}`);
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
  const costText =
    costSummary && costSummary.state !== 'unavailable'
      ? `${costSummary.state === 'exact' ? 'Cost' : 'Est'} ${formatStatusBarCost(costSummary.knownUsdMicros)}${
          costSummary.state === 'partial' ? '+' : ''
        }`
      : '';

  const warningText = (() => {
    if (!largeUncachedWarning || usageHasIntegratedWarning) {
      return '';
    }
    if (hasPendingConfirmation) {
      const tokens = pendingLargeUncachedTokens ?? largeUncachedWarning.estimatedTokens;
      return `${GLYPH_WARNING} Confirm Cache Miss: ~${Math.round(tokens / 1000)}k`;
    }
    return `${GLYPH_WARNING} Cache Miss Risk: ~${Math.round(largeUncachedWarning.estimatedTokens / 1000)}k`;
  })();

  const openCodeGoUsageText = (() => {
    if (!openCodeGoUsage) return '';
    const formatReset = (seconds: number): string => {
      if (seconds < 60) return `${Math.round(seconds)}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
    };
    const formatLimit = (label: string, limit: { usagePercent: number; resetInSec: number }) =>
      `${label} ${Math.round(limit.usagePercent)}% · reset ${formatReset(limit.resetInSec)}`;
    return [
      formatLimit('Roll', openCodeGoUsage.rollingUsage),
      formatLimit('Week', openCodeGoUsage.weeklyUsage),
      formatLimit('Month', openCodeGoUsage.monthlyUsage),
    ].join(' / ');
  })();

  const codexRateLimitText = (() => {
    if (!lastCodexRateLimit) return '';

    const isNumber = (value: unknown): value is number => typeof value === 'number' && !isNaN(value);

    // Codex decides which slot carries which window, so derive the unit from the
    // window length instead of assuming primary is short and secondary is weekly.
    const formatWindow = (minutes: number): string => {
      if (minutes >= 24 * 60) return `${Math.round(minutes / (24 * 60))}D`;
      if (minutes >= 60) return `${Math.round(minutes / 60)}H`;
      return `${Math.round(minutes)}M`;
    };

    const formatDate = (date: Date): string =>
      `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;

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
        return formatDate(resetDate);
      }
      return windowMinutes >= 24 * 60 ? `${formatDate(resetDate)} ${formatTime(resetDate)}` : formatTime(resetDate);
    };

    const formatWindowUsage = (window: CodexRateLimitWindow | undefined): string | undefined => {
      if (!window || !isNumber(window.window_minutes) || !isNumber(window.used_percent) || !isNumber(window.reset_at)) {
        return undefined;
      }
      const reset = formatReset(window.reset_at, window.window_minutes);
      return `${formatWindow(window.window_minutes)} ${window.used_percent}% · reset ${reset}`;
    };

    return [lastCodexRateLimit.primary, lastCodexRateLimit.secondary]
      .map(formatWindowUsage)
      .filter((part): part is string => part !== undefined)
      .join(' / ');
  })();

  // Grok reports one weekly credit percentage, not the rolling used/reset
  // windows Codex reports, so it gets its own formatting in the same slot —
  // only one provider is active at a time. `formatDate` and `formatTime` above
  // belong to the Codex block; this one needs only the period end.
  const grokCreditUsageText = (() => {
    if (!grokCreditUsage || typeof grokCreditUsage.creditUsagePercent !== 'number') return '';

    const percent = Math.round(grokCreditUsage.creditUsagePercent);
    const periodEndMs = grokCreditUsage.periodEndMs;
    if (periodEndMs === undefined) return `Credits ${percent}%`;

    const resetDate = new Date(periodEndMs);
    const reset = `${String(resetDate.getMonth() + 1).padStart(2, '0')}/${String(resetDate.getDate()).padStart(
      2,
      '0',
    )}`;
    return `Credits ${percent}% · reset ${reset}`;
  })();

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
  const runBudgetNoticeText = (() => {
    if (!runBudgetNotice) return '';
    if (runBudgetNotice.type === 'tool_stall') {
      return `${GLYPH_WARNING} Possible stall: ${runBudgetNotice.toolName} ×${runBudgetNotice.count}`;
    }
    const { dimension, used, limit } = runBudgetNotice.evidence;
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 100;
    switch (dimension) {
      case 'usd':
        return `${GLYPH_WARNING} Run cost: ${formatUsdMicros(used)} / ${formatUsdMicros(limit)} (${percent}%)`;
      case 'unpriced_tokens':
        return `${GLYPH_WARNING} Run tokens: ${formatStatusBarTokens(used)} / ${formatStatusBarTokens(
          limit,
        )} (${percent}%)`;
      case 'active_time':
        return `${GLYPH_WARNING} Run time: ${formatActiveTime(used)} / ${formatActiveTime(limit)} (${percent}%)`;
      case 'turns':
        return `${GLYPH_WARNING} Run turns: ${used} / ${limit} (${percent}%)`;
      default:
        return `${GLYPH_WARNING} Run budget: ${percent}%`;
    }
  })();

  const staticCommitBlockerText = (() => {
    if (!staticCommitBlocker) {
      return '';
    }

    const sender = staticCommitBlocker.sender ?? 'unknown';
    const status = staticCommitBlocker.status ?? staticCommitBlocker.reason;
    const chars = Math.round(staticCommitBlocker.dynamicTextLength / 1000);
    return `Static blocked: ${sender}/${status} (${staticCommitBlocker.dynamicMessageCount} msgs, ${chars}k chars)`;
  })();

  const modeLabels = [
    ...(liteMode ? ['Lite'] : []),
    ...(mentorMode ? ['Mentor'] : []),
    ...(planMode ? ['Plan'] : []),
    ...(orchestratorMode ? ['Orchestrator'] : []),
  ];
  const modeLabel = modeLabels.length > 0 ? modeLabels.join(' · ') : 'Standard';
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

  const safetyColor = autoApproveAlways ? warnRed : sandboxEnabled || autoApproveMode === 'auto' ? COLOR_SUCCESS : glow;

  // The alert row is where every non-steady-state message lands. Keeping them
  // in one row (rather than stacked beside the identity segments, as before)
  // means the bar is a single line whenever nothing is wrong — which is most
  // of the time — and grows only to say something.
  const hasAlerts = Boolean(warningText || dockerHostAccess || runBudgetNoticeText || staticCommitBlockerText);
  const quotaText = codexRateLimitText || grokCreditUsageText || openCodeGoUsageText;

  // Segments as data: each group is fit to the *full* row budget on its own
  // (drop order below), and only afterward do the two fitted groups get
  // compared to see whether they still coexist on one line. That keeps the
  // drop decision for each group independent of whatever the other group is
  // doing, per the drop-order contract each priority list documents.
  const configSegments: StatusSegment[] = [
    { id: 'ssh-marker', text: sshInfo ? 'SSH' : '', color: glow, bold: true },
    {
      id: 'ssh-detail',
      text: sshInfo ? ` ${sshInfo.user}@${sshInfo.host}:${sshInfo.remoteDir}` : '',
      color: slate,
      tier: 5,
    },
    {
      id: 'mode',
      text: modeLabel,
      color: modeLabel === 'Standard' ? slate : accent,
      bold: modeLabel !== 'Standard',
      separator: 'group',
    },
    {
      id: 'queue',
      text: queueLength != null && queueLength > 0 ? `[Q:${queueLength}]` : '',
      color: accent,
      separator: 'group',
      tier: 3,
    },
    {
      id: 'provider-model',
      text: model ? `${providerLabel}/${model}` : '',
      color: accent,
      separator: 'group',
    },
    {
      id: 'reasoning',
      text: model && reasoningEffort && reasoningEffort !== 'default' ? ` · ${reasoningEffort}` : '',
      color: glow,
      tier: 2,
    },
    {
      id: 'mentor',
      text: mentorMode && mentorModel ? mentorModel : '',
      color: COLOR_ACCENT_ALT,
      separator: 'group',
      tier: 1,
    },
    {
      id: 'safety',
      text: safetyLabel,
      color: safetyColor,
      bold: true,
      separator: 'group',
      tier: 4,
    },
  ];

  const metricsSegments: StatusSegment[] = [
    { id: 'tokens', text: tokensText, color: usageColor, bold: Boolean(largeUncachedWarning), tier: 4 },
    {
      id: 'cache',
      text: cacheText,
      color: usageHasIntegratedWarning ? usageColor : slate,
      bold: usageHasIntegratedWarning ? Boolean(largeUncachedWarning) : false,
      separator: 'metric',
      // The alert variant of this segment is the warning itself, so it must
      // stay on screen for as long as it's showing — dropping it would hide
      // the one thing it exists to say.
      tier: usageHasIntegratedWarning ? undefined : 1,
    },
    { id: 'context', text: contextText, color: slate, separator: 'metric', tier: 3 },
    { id: 'cost', text: costText, color: slate, separator: 'metric', tier: 2 },
  ];

  const configFit = fitGroup(configSegments, budget, 'provider-model');
  const metricsFit = fitGroup(metricsSegments, budget);
  const bothVisible = configFit.visible.length > 0 && metricsFit.visible.length > 0;
  const combinedWidth = configFit.width + (bothVisible ? GROUP_SEPARATOR_WIDTH : 0) + metricsFit.width;
  const metricsOnOwnRow = metricsFit.visible.length > 0 && combinedWidth > budget;

  return (
    <Box marginTop={1} flexDirection="column" width="100%" paddingX={1}>
      {/* Configuration (left) and this turn's numbers (right). No flexWrap: a
          miscalculated budget should clip a segment via wrap="truncate-end",
          never reflow it mid-word the way the row-level wrap used to. */}
      <Box width="100%">
        {renderSegments(configFit.visible)}
        {!metricsOnOwnRow && metricsFit.visible.length > 0 && (
          <>
            <Divider />
            {renderSegments(metricsFit.visible)}
          </>
        )}
      </Box>
      {metricsOnOwnRow && (
        <Box width="100%" justifyContent="flex-end">
          {renderSegments(metricsFit.visible)}
        </Box>
      )}

      {/* Alerts (left) and provider quota (right). Absent when neither exists. */}
      {(hasAlerts || quotaText) && (
        <Box width="100%">
          <Box flexGrow={1}>
            {warningText && (
              <Text color={hasPendingConfirmation ? warnRed : glow} bold wrap="truncate-end">
                {warningText}
              </Text>
            )}
            {dockerHostAccess && (
              <>
                {warningText && <Divider />}
                <Text color={slate} wrap="truncate-end">
                  Docker host access:{' '}
                </Text>
                <Text color={glow} bold wrap="truncate-end">
                  {dockerHostAccess}
                </Text>
              </>
            )}
            {runBudgetNoticeText && (
              <>
                {(warningText || dockerHostAccess) && <Divider />}
                <Text color={glow} bold wrap="truncate-end">
                  {runBudgetNoticeText}
                </Text>
              </>
            )}
            {staticCommitBlockerText && (
              <>
                {(warningText || dockerHostAccess || runBudgetNoticeText) && <Divider />}
                <Text color={warnRed} bold wrap="truncate-end">
                  {staticCommitBlockerText}
                </Text>
              </>
            )}
          </Box>

          {quotaText && (
            <Box flexShrink={0}>
              <Text color={slate} wrap="truncate-end">
                {quotaText}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

export default StatusBar;
