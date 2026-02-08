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
  const editMode = useSetting<boolean>(settingsService, 'app.editMode') ?? false;
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;
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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={2} paddingY={1}>
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
          {liteMode && isShellMode ? (
            <Text backgroundColor="#ca8a04" color="white" bold>
              {' '}
              SHELL{' '}
            </Text>
          ) : (
            liteMode && (
              <Text backgroundColor="#059669" color="white" bold>
                {' '}
                LITE{' '}
              </Text>
            )
          )}
          {editMode && (
            <Text backgroundColor="#1d4ed8" color="white" bold>
              {' '}
              EDIT{' '}
            </Text>
          )}
          {mentorMode && (
            <Text backgroundColor="#7c3aed" color="white" bold>
              {' '}
              MENTOR{' '}
            </Text>
          )}
          {!editMode && !mentorMode && !liteMode && (
            <Text backgroundColor="#0f766e" color="white" bold>
              {' '}
              DEFAULT{' '}
            </Text>
          )}
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
