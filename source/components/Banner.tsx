import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { useSetting } from '../hooks/use-setting.js';
import { getProvider } from '../providers/index.js';
import type { SettingsService } from '../services/settings-service.js';

interface BannerProps {
  settingsService: SettingsService;
  isShellMode?: boolean;
}

const Banner: FC<BannerProps> = ({ settingsService, isShellMode = false }) => {
  const mentorMode = useSetting<boolean>(settingsService, 'app.mentorMode') ?? false;
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;
  const planMode = useSetting<boolean>(settingsService, 'app.planMode') ?? false;
  const orchestratorMode = useSetting<boolean>(settingsService, 'app.orchestratorMode') ?? false;
  const model = useSetting<string>(settingsService, 'agent.model');
  const mentorModel = useSetting<string>(settingsService, 'agent.mentorModel');
  const providerKey = useSetting<string>(settingsService, 'agent.provider') ?? 'openai';
  const reasoningEffort = useSetting<string>(settingsService, 'agent.reasoningEffort') ?? 'default';
  const mentorReasoningEffort = useSetting<string>(settingsService, 'agent.mentorReasoningEffort') ?? 'default';

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;

  const accent = '#0ed7b5';
  const glow = '#fbbf24';
  const slate = '#64748b';
  const purple = '#a78bfa'; // Soft purple for mentor
  const cyan = '#22d3ee'; // Soft cyan for provider
  const lightSlate = '#94a3b8';

  const Pill: FC<{ bg: string; label: string }> = ({ bg, label }) => (
    <Text backgroundColor={bg} color="white" bold>
      {' '}
      {label}{' '}
    </Text>
  );

  const baseMode = orchestratorMode
    ? 'ORCHESTRATOR'
    : planMode
    ? 'PLAN'
    : liteMode
    ? isShellMode
      ? 'SHELL'
      : 'LITE'
    : 'STANDARD';

  const pills = [
    {
      show: true,
      label: baseMode,
      bg:
        baseMode === 'ORCHESTRATOR'
          ? '#be123c'
          : baseMode === 'PLAN'
          ? '#0369a1'
          : baseMode === 'SHELL'
          ? '#ca8a04'
          : baseMode === 'LITE'
          ? '#059669'
          : '#0f766e',
    },
    { show: mentorMode, label: 'MENTOR', bg: '#7c3aed' },
  ];

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={accent}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      {/* Header */}
      <Box justifyContent="space-between" alignItems="center">
        <Box alignItems="center">
          <Text color={glow} bold>
            {'▌'}
          </Text>
          <Text color={accent} bold>
            {' '}
            term²
          </Text>
        </Box>

        {/* Mode pills */}
        <Box gap={1}>
          {pills
            .filter((p) => p.show)
            .map((p) => (
              <Pill key={p.label} bg={p.bg} label={p.label} />
            ))}
        </Box>
      </Box>

      {/* Status line */}
      <Box justifyContent="space-between" marginTop={1} flexWrap="wrap">
        <Box flexDirection="column" marginRight={3}>
          <Text color={slate}>
            Provider:{' '}
            <Text color={cyan} bold>
              {providerLabel}
            </Text>
          </Text>
          <Box flexDirection="column">
            <Text color={slate}>
              Model:{' '}
              <Text color={glow} bold>
                {model ? (model.length > 34 ? `${model.slice(0, 31)}…` : model) : '—'}
              </Text>
              {reasoningEffort !== 'none' && (
                <Text color={slate}>
                  {' '}
                  <Text color={lightSlate}>({reasoningEffort})</Text>
                </Text>
              )}
            </Text>
            {mentorMode && mentorModel && (
              <Text color={slate}>
                Mentor:{' '}
                <Text color={purple} bold>
                  {mentorModel.length > 34 ? `${mentorModel.slice(0, 31)}…` : mentorModel}
                </Text>
                {mentorReasoningEffort !== 'none' && (
                  <Text color={slate}>
                    {' '}
                    <Text color={lightSlate}>({mentorReasoningEffort})</Text>
                  </Text>
                )}
              </Text>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default Banner;
