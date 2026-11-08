import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { MODEL_LABEL_MAX } from '../shared/limits.js';
import type { AssistantFrameProps, BannerView, UserMessageView } from '../types.js';

const truncateModel = (name: string): string =>
  name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;

/**
 * Two borderless lines, not a bordered block. The banner is the first thing on
 * screen every session; a full box around it competes with the conversation
 * below for attention and costs four lines to say four short facts.
 */
export const ClassicBanner: FC<BannerView> = ({ version, providerLabel, model, reasoningEffort }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" width="100%" paddingTop={1} marginBottom={1}>
      <Box>
        <Text color={theme.warning} bold>
          ▌
        </Text>
        <Text color={theme.accent} bold>
          {' '}
          term²{' '}
        </Text>
        <Text color={theme.textMuted}> v{version}</Text>
      </Box>

      <Box>
        <Text color={theme.textSubtle}>{'  '}</Text>
        <Text color={theme.textMuted}>{providerLabel}</Text>
        <Text color={theme.textSubtle}>/</Text>
        <Text color={theme.accent}>{model ? truncateModel(model) : '—'}</Text>
        {reasoningEffort !== 'none' && <Text color={theme.textSubtle}> ({reasoningEffort})</Text>}
      </Box>
    </Box>
  );
};

/** A full-width band, so user messages read as content blocks rather than another accent-coloured header. */
export const ClassicUserMessage: FC<UserMessageView> = ({ text }) => {
  const theme = useTheme();
  return (
    <Box width="100%" backgroundColor={theme.userBackground} paddingX={1}>
      <Text bold color={theme.userText}>
        <Text color={theme.accent}>❯ </Text>
        {text}
      </Text>
    </Box>
  );
};

/** Answers and reasoning are printed bare; the frame exists so other skins can mark or indent them. */
export const ClassicAssistantFrame: FC<AssistantFrameProps> = ({ children }) => <>{children}</>;
