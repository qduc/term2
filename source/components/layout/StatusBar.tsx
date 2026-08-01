import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { useSetting } from '../../hooks/use-setting.js';
import { hasDockerHostControlProject } from '../../utils/shell/sandbox/docker-host-control-grants.js';
import { getProvider } from '../../providers/index.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { SSHInfo } from '../../hooks/use-shell-mode.js';
import { formatFooterUsage, type NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { CodexRateLimitInfo, CodexRateLimitWindow } from '../../services/conversation/conversation-events.js';
import type { StaticCommitBlocker } from '../message/MessageList.js';

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
  const choreModel = useSetting(settingsService, 'agent.choreModel');
  const legacyAutoApproveModel = useSetting(settingsService, 'agent.autoApproveModel');
  const autoApproveModel = choreModel ?? legacyAutoApproveModel;
  const sandboxEnabled = useSetting(settingsService, 'sandbox.enabled') ?? false;
  const sandboxReadPolicy = useSetting(settingsService, 'sandbox.readPolicy') ?? 'standard';
  // Session-scoped grants are intentionally not process-global, so only the
  // persistent project grant is discoverable from this app-wide status bar.
  const dockerHostAccess = hasDockerHostControlProject(process.cwd()) ? 'project' : undefined;

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;

  const slate = '#64748b';
  const glow = '#fbbf24';
  const accent = '#0ed7b5';
  const warnRed = '#ef4444';

  const usageHasCacheRead = lastUsage?.cache_read_tokens != null;
  const usageHasIntegratedWarning = Boolean(largeUncachedWarning && usageHasCacheRead);
  const usageText = formatFooterUsage(lastUsage, { cacheWarning: usageHasIntegratedWarning });
  const usageColor = largeUncachedWarning ? (hasPendingConfirmation ? warnRed : glow) : slate;

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

    // A reset further out than a day only needs a date. A reset landing within
    // 24h needs the clock time, plus the date when the window itself spans days
    // so it stays clear the reset can be tomorrow rather than later today.
    const formatReset = (resetAt: number, windowMinutes: number): string => {
      const resetDate = new Date(resetAt * 1000);
      const diffMs = resetDate.getTime() - Date.now();
      const within24Hours = diffMs >= 0 && diffMs < 24 * 60 * 60 * 1000;
      if (!within24Hours) {
        return resetDate.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
      }
      return windowMinutes >= 24 * 60
        ? resetDate.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const formatWindowUsage = (window: CodexRateLimitWindow | undefined): string | undefined => {
      if (!window || !isNumber(window.window_minutes) || !isNumber(window.used_percent) || !isNumber(window.reset_at)) {
        return undefined;
      }
      const reset = formatReset(window.reset_at, window.window_minutes);
      return `${formatWindow(window.window_minutes)}: ${window.used_percent}% (${reset})`;
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

  return (
    <Box marginTop={1} flexDirection="column" width="100%">
      {/* Row 1: Primary Configuration */}
      <Box justifyContent="space-between" width="100%">
        <Box>
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
          <Box marginRight={1} marginLeft={sshInfo ? 1 : 0} gap={1}>
            {liteMode && (
              <>
                <Text color="#10b981" bold>
                  Lite
                </Text>
                <Text color={isShellMode ? '#ca8a04' : '#3b82f6'} bold>
                  {isShellMode ? 'Shell' : 'Ask'}
                </Text>
              </>
            )}
            {mentorMode && (
              <Text color="#a78bfa" bold>
                Mentor
              </Text>
            )}
            {planMode && (
              <Text color="#22d3ee" bold>
                Plan
              </Text>
            )}
            {orchestratorMode && (
              <Text color="#f59e0b" bold>
                Orchestrator
              </Text>
            )}
            {!mentorMode && !liteMode && !planMode && !orchestratorMode && <Text color={slate}>Standard</Text>}

            {queueLength != null && queueLength > 0 && (
              <>
                <Text color={slate}>│</Text>
                <Box marginX={1}>
                  <Text color={accent}>[Q:{queueLength}]</Text>
                </Box>
              </>
            )}
          </Box>

          {model && (
            <>
              <Text color={slate}>│</Text>
              <Box marginX={1}>
                <Text color={accent}>{model}</Text>
                <Text color={slate}> ({providerLabel})</Text>
                {reasoningEffort && reasoningEffort !== 'default' && (
                  <Text color={slate}>
                    {' '}
                    <Text color={glow}>({reasoningEffort})</Text>
                  </Text>
                )}
              </Box>
            </>
          )}

          {mentorMode && mentorModel && (
            <>
              <Text color={slate}>│</Text>
              <Box marginX={1}>
                <Text color={slate}>Mentor: </Text>
                <Text color="#a78bfa">{mentorModel}</Text>
              </Box>
            </>
          )}
        </Box>

        {/* Far-right: Codex rate limit display */}
        {codexRateLimitText && (
          <Box>
            <Text color={slate}>{codexRateLimitText}</Text>
          </Box>
        )}
      </Box>

      {/* Row 2: Status & Metrics */}
      <Box width="100%">
        <Box flexGrow={1}>
          <Box>
            {sandboxEnabled ? (
              <Box marginRight={1}>
                <Text color={slate}>Sandbox: </Text>
                <Text color="#10b981" bold>
                  ON
                </Text>
                <Text color={slate}> ({sandboxReadPolicy})</Text>
              </Box>
            ) : (
              autoApproveMode !== 'off' && (
                <Box marginRight={1}>
                  <Text color={slate}>Approve: </Text>
                  <Text color={autoApproveMode === 'auto' ? '#10b981' : '#f97316'} bold>
                    {autoApproveMode}
                  </Text>
                  {autoApproveModel && <Text color={slate}> ({autoApproveModel})</Text>}
                </Box>
              )
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
        </Box>

        {usageText ? (
          <Box>
            <Text color={usageColor} bold={Boolean(largeUncachedWarning)}>
              {usageText}
            </Text>
          </Box>
        ) : (
          warningText && (
            <Box>
              <Text color={hasPendingConfirmation ? warnRed : glow} bold>
                {warningText}
              </Text>
            </Box>
          )
        )}
      </Box>
    </Box>
  );
};

export default StatusBar;
