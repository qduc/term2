import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { useSetting } from '../../hooks/use-setting.js';
import { getProvider } from '../../providers/index.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import {
  COLOR_ACCENT,
  COLOR_ACCENT_ALT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SUBTLE,
  COLOR_WARNING,
  GLYPH_SEPARATOR,
  MODE_BADGE_BACKGROUND,
  MODE_BADGE_FOREGROUND,
  type ModeBadge,
} from '../theme.js';

interface BannerProps {
  settingsService: SettingsService;
  isShellMode?: boolean;
}

const MAX_MODEL_LABEL = 34;

const truncateModel = (name: string): string =>
  name.length > MAX_MODEL_LABEL ? `${name.slice(0, MAX_MODEL_LABEL - 1)}…` : name;

const Badge: FC<{ mode: ModeBadge }> = ({ mode }) => (
  <Text backgroundColor={MODE_BADGE_BACKGROUND[mode]} color={MODE_BADGE_FOREGROUND} bold>
    {' '}
    {mode}{' '}
  </Text>
);

const Banner: FC<BannerProps> = ({ settingsService, isShellMode = false }) => {
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
  const mentorReasoningEffort = useSetting(settingsService, 'agent.mentorReasoningEffort') ?? 'default';

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;

  const baseMode: ModeBadge = orchestratorMode
    ? 'ORCHESTRATOR'
    : planMode
    ? 'PLAN'
    : liteMode
    ? isShellMode
      ? 'SHELL'
      : 'LITE'
    : 'STANDARD';

  // Two borderless lines, not a bordered block. The banner is the first thing
  // on screen every session; a full box around it competes with the conversation
  // below for attention and costs four lines to say four short facts.
  return (
    <Box flexDirection="column" width="100%" marginBottom={1}>
      <Box>
        <Text color={COLOR_WARNING} bold>
          ▌
        </Text>
        <Text color={COLOR_ACCENT} bold>
          {' '}
          term²{' '}
        </Text>
        <Badge mode={baseMode} />
        {mentorMode && (
          <>
            <Text> </Text>
            <Badge mode="MENTOR" />
          </>
        )}
      </Box>

      <Box>
        <Text color={COLOR_TEXT_SUBTLE}>{'  '}</Text>
        <Text color={COLOR_TEXT_MUTED}>{providerLabel}</Text>
        <Text color={COLOR_TEXT_SUBTLE}>/</Text>
        <Text color={COLOR_ACCENT}>{model ? truncateModel(model) : '—'}</Text>
        {reasoningEffort !== 'none' && <Text color={COLOR_TEXT_SUBTLE}> ({reasoningEffort})</Text>}

        {mentorMode && mentorModel && (
          <>
            <Text color={COLOR_TEXT_SUBTLE}> {GLYPH_SEPARATOR} </Text>
            <Text color={COLOR_TEXT_SUBTLE}>mentor </Text>
            <Text color={COLOR_ACCENT_ALT}>{truncateModel(mentorModel)}</Text>
            {mentorReasoningEffort !== 'none' && <Text color={COLOR_TEXT_SUBTLE}> ({mentorReasoningEffort})</Text>}
          </>
        )}
      </Box>
    </Box>
  );
};

export default Banner;
