import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { useSetting } from '../hooks/use-setting.js';
import { getProvider } from '../providers/index.js';
import type { SettingsService } from '../services/settings-service.js';
import type { SSHInfo } from '../hooks/use-shell-mode.js';
import { formatFooterUsage, type NormalizedUsage } from '../utils/token-usage.js';
import type { CodexRateLimitInfo } from '../services/conversation-events.js';

interface StatusBarProps {
  settingsService: SettingsService;
  isShellMode?: boolean;
  sshInfo?: SSHInfo;
  lastUsage?: NormalizedUsage | null;
  lastCodexRateLimit?: CodexRateLimitInfo | null;
}

const StatusBar: FC<StatusBarProps> = ({
  settingsService,
  isShellMode = false,
  sshInfo,
  lastUsage,
  lastCodexRateLimit,
}) => {
  const mentorMode = useSetting<boolean>(settingsService, 'app.mentorMode') ?? false;
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;
  const planMode = useSetting<boolean>(settingsService, 'app.planMode') ?? false;
  const orchestratorMode = useSetting<boolean>(settingsService, 'app.orchestratorMode') ?? false;
  const model = useSetting<string>(settingsService, 'agent.model');
  const mentorModel = useSetting<string>(settingsService, 'agent.mentorModel');
  const providerKey = useSetting<string>(settingsService, 'agent.provider') ?? 'openai';
  const reasoningEffort = useSetting<string>(settingsService, 'agent.reasoningEffort') ?? 'default';
  const autoApproveMode = useSetting<string>(settingsService, 'shell.autoApproveMode') ?? 'off';
  const autoApproveModel = useSetting<string>(settingsService, 'agent.autoApproveModel');

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;

  const slate = '#64748b';
  const glow = '#fbbf24';
  const accent = '#0ed7b5';

  const usageText = formatFooterUsage(lastUsage);

  const codexRateLimitText = (() => {
    if (!lastCodexRateLimit) return '';
    const { primary, secondary } = lastCodexRateLimit;
    const parts: string[] = [];

    if (primary) {
      const hours = Math.round(primary.window_minutes / 60);
      const resetDate = new Date(primary.reset_at * 1000);
      const timeStr = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      parts.push(`${hours}H: ${primary.used_percent}% (reset at ${timeStr})`);
    }
    if (secondary) {
      const days = Math.round(secondary.window_minutes / (60 * 24));
      const resetDate = new Date(secondary.reset_at * 1000);
      const dateStr = resetDate.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
      parts.push(`${days}D: ${secondary.used_percent}% (reset on ${dateStr})`);
    }
    return parts.join(' / ');
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
          {autoApproveMode !== 'off' && (
            <Box marginRight={1}>
              <Text color={slate}>Auto: </Text>
              <Text color={autoApproveMode === 'auto' ? '#10b981' : '#f97316'} bold>
                {autoApproveMode}
              </Text>
              {autoApproveModel && <Text color={slate}> ({autoApproveModel})</Text>}
            </Box>
          )}
        </Box>

        {usageText && (
          <Box>
            <Text color={slate}>{usageText}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

export default StatusBar;
