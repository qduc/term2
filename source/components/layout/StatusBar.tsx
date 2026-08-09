import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { useSetting } from '../../hooks/use-setting.js';
import { hasDockerHostControlProject } from '../../utils/shell/sandbox/docker-host-control-grants.js';
import { getProvider } from '../../providers/index.js';
import { getModelContextWindow } from '../../providers/model-catalog/catalog.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { SSHInfo } from '../../services/shell/shell-interaction-session.js';
import { formatContextUsage, type NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { CodexRateLimitInfo, CodexRateLimitWindow } from '../../services/conversation/conversation-events.js';
import type { StaticCommitBlocker } from '../message/MessageList.js';
import { formatUsdMicros, type SessionCostSummary } from '../../services/cost/model-cost.js';

function formatStatusBarTokens(tokens: number): string {
  return tokens > 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : tokens.toLocaleString();
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
  isShellMode?: boolean;
  sshInfo?: SSHInfo;
  lastUsage?: NormalizedUsage | null;
  lastCodexRateLimit?: CodexRateLimitInfo | null;
  largeUncachedWarning?: { estimatedTokens: number } | null;
  hasPendingConfirmation?: boolean;
  pendingLargeUncachedTokens?: number;
  staticCommitBlocker?: StaticCommitBlocker | null;
  queueLength?: number;
  costSummary?: SessionCostSummary | null;
}

const StatusBar: FC<StatusBarProps> = ({
  settingsService,
  isShellMode = false,
  sshInfo,
  lastUsage,
  lastCodexRateLimit,
  largeUncachedWarning,
  hasPendingConfirmation = false,
  pendingLargeUncachedTokens,
  staticCommitBlocker = null,
  queueLength,
  costSummary,
}) => {
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
  const dockerHostAccess = hasDockerHostControlProject(process.cwd()) ? 'project' : undefined;

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;

  // Context gauge: last request's prompt tokens (the current conversation
  // context) over the vendored catalog's context window for the active model.
  const contextWindow = model ? getModelContextWindow(providerKey, model) : undefined;
  const contextTokens = lastUsage?.prompt_tokens;
  const contextUsageText =
    contextWindow != null && contextTokens != null ? formatContextUsage(contextTokens, contextWindow) : '';

  const slate = '#64748b';
  const glow = '#fbbf24';
  const accent = '#0ed7b5';
  const warnRed = '#ef4444';

  const cacheReadTokens = lastUsage?.cache_read_tokens;
  const usageHasCacheRead = cacheReadTokens != null && cacheReadTokens > 0;
  const usageHasIntegratedWarning = Boolean(largeUncachedWarning && usageHasCacheRead);
  const usageColor = largeUncachedWarning ? (hasPendingConfirmation ? warnRed : glow) : slate;

  const tokenParts: string[] = [];
  if (lastUsage?.prompt_tokens != null) {
    const cachePercentage =
      usageHasCacheRead && lastUsage.prompt_tokens > 0
        ? ((cacheReadTokens / lastUsage.prompt_tokens) * 100).toFixed(1)
        : '';
    const cacheText = usageHasCacheRead
      ? usageHasIntegratedWarning
        ? `⚠️ ${formatStatusBarTokens(cacheReadTokens)} uncached`
        : `${cachePercentage}% cached`
      : '';
    tokenParts.push(`↑ ${formatStatusBarTokens(lastUsage.prompt_tokens)}${cacheText ? ` (${cacheText})` : ''}`);
  }
  if (lastUsage?.completion_tokens != null) tokenParts.push(`↓ ${formatStatusBarTokens(lastUsage.completion_tokens)}`);
  const tokensText = tokenParts.join(' / ');
  const contextText = contextUsageText ? `Ctx ${contextUsageText.replace('/', ' / ')}` : '';
  const costText =
    costSummary && costSummary.state !== 'unavailable'
      ? `${costSummary.state === 'exact' ? 'Cost' : 'Est'} ${formatUsdMicros(costSummary.knownUsdMicros)}${
          costSummary.state === 'partial' ? '+' : ''
        }`
      : '';
  const costColor = costSummary?.state === 'partial' ? warnRed : slate;

  const warningText = (() => {
    if (!largeUncachedWarning || usageHasIntegratedWarning) {
      return '';
    }
    if (hasPendingConfirmation) {
      const tokens = pendingLargeUncachedTokens ?? largeUncachedWarning.estimatedTokens;
      return `⚠️ Confirm Cache Miss: ~${Math.round(tokens / 1000)}k`;
    }
    return `⚠️ Cache Miss Risk: ~${Math.round(largeUncachedWarning.estimatedTokens / 1000)}k`;
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
    ...(liteMode ? [`Lite · ${isShellMode ? 'Shell' : 'Ask'}`] : []),
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

  return (
    <Box marginTop={1} flexDirection="column" width="100%">
      <Box width="100%" flexWrap="wrap">
        <Box flexGrow={1}>
          {sshInfo && (
            <>
              <Box marginRight={1}>
                <Text color="#f97316" bold>
                  SSH
                </Text>
                <Text color={slate}>
                  {' '}
                  {sshInfo.user}@{sshInfo.host}:{sshInfo.remoteDir}
                </Text>
              </Box>
              <Text color={slate}>│</Text>
            </>
          )}
          <Box marginX={1}>
            <Text color={modeLabel === 'Standard' ? slate : accent} bold={modeLabel !== 'Standard'}>
              {modeLabel}
            </Text>
            {queueLength != null && queueLength > 0 && (
              <>
                <Text color={slate}> │ </Text>
                <Text color={accent}>[Q:{queueLength}]</Text>
              </>
            )}
          </Box>

          {model && (
            <>
              <Text color={slate}>│</Text>
              <Box marginX={1}>
                <Text color={accent}>
                  {providerLabel}/{model}
                </Text>
                {reasoningEffort && reasoningEffort !== 'default' && <Text color={glow}> · {reasoningEffort}</Text>}
              </Box>
            </>
          )}

          {mentorMode && mentorModel && (
            <>
              <Text color={slate}>│</Text>
              <Box marginX={1}>
                <Text color="#a78bfa">{mentorModel}</Text>
              </Box>
            </>
          )}
        </Box>

        {(tokensText || contextText || costText) && (
          <Box>
            {tokensText && (
              <Text color={usageColor} bold={Boolean(largeUncachedWarning)}>
                {tokensText}
              </Text>
            )}
            {tokensText && contextText && <Text color={slate}> │ </Text>}
            {contextText && <Text color={slate}>{contextText}</Text>}
            {(tokensText || contextText) && costText && <Text color={slate}> │ </Text>}
            {costText && <Text color={costColor}>{costText}</Text>}
          </Box>
        )}
      </Box>

      <Box width="100%" flexWrap="wrap">
        <Box flexGrow={1}>
          {safetyLabel && (
            <Box marginRight={1}>
              <Text
                color={
                  autoApproveAlways ? warnRed : sandboxEnabled || autoApproveMode === 'auto' ? '#10b981' : '#f97316'
                }
                bold
              >
                {safetyLabel}
              </Text>
            </Box>
          )}
          {warningText && (
            <Text color={hasPendingConfirmation ? warnRed : glow} bold>
              {warningText}
            </Text>
          )}
          {dockerHostAccess && (
            <Box marginRight={1}>
              <Text color={slate}>Docker host access: </Text>
              <Text color={glow} bold>
                {dockerHostAccess}
              </Text>
            </Box>
          )}
          {staticCommitBlockerText && (
            <Box marginRight={1}>
              <Text color={warnRed} bold>
                {staticCommitBlockerText}
              </Text>
            </Box>
          )}
        </Box>

        {codexRateLimitText && (
          <Box>
            <Text color={slate}>{codexRateLimitText}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

export default StatusBar;
