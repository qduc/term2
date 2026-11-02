import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { MODEL_LABEL_MAX } from '../shared/limits.js';
import type { AssistantFrameProps, BannerView, UserMessageView } from '../types.js';
import { Chip } from './chip.js';

const truncateModel = (name: string): string =>
  name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;

/**
 * One header bar: the product chip, then facts. The bar is a band on `codeBackground`,
 * so a chip cannot use that surface here; the mode badge keeps its own identity colour
 * and the product chip is solid. The facts are grouped, so a narrow terminal wraps
 * between groups (`term² v1.2`, `provider/model effort`, `mentor ...`) and never inside one.
 */
export const LedgerBanner: FC<BannerView> = ({
  version,
  mode,
  mentor,
  providerLabel,
  model,
  reasoningEffort,
  mentorModel,
  mentorReasoningEffort,
}) => {
  const theme = useTheme();
  const showEffort = (effort: string) => effort !== 'none' && effort !== 'default';
  return (
    <Box width="100%" marginTop={1} marginBottom={1}>
      <Box width="100%" backgroundColor={theme.codeBackground} flexWrap="wrap" columnGap={2}>
        <Box>
          <Text>
            <Chip solid tone="accent">
              term²
            </Chip>
            <Text color={theme.textMuted}> v{version}</Text>
            {mode !== 'STANDARD' && (
              <>
                {' '}
                <Chip tone="accent" bold surface={theme.modeBadge[mode]} surfaceText={theme.modeBadgeForeground}>
                  {mode}
                </Chip>
              </>
            )}
            {mentor && (
              <>
                {' '}
                <Chip tone="accentAlt" bold surface={theme.modeBadge.MENTOR} surfaceText={theme.modeBadgeForeground}>
                  MENTOR
                </Chip>
              </>
            )}
          </Text>
        </Box>
        <Box>
          <Text>
            <Text color={theme.textMuted}>{providerLabel}</Text>
            <Text color={theme.textSubtle}>/</Text>
            <Text color={theme.accent} bold>
              {model ? truncateModel(model) : '—'}
            </Text>
            {showEffort(reasoningEffort) && <Text color={theme.warning}> {reasoningEffort}</Text>}
          </Text>
        </Box>
        {mentor && mentorModel && (
          <Box>
            <Text>
              <Text color={theme.textMuted}>mentor</Text>
              <Text color={theme.accentAlt} bold>
                {truncateModel(mentorModel)}
              </Text>
              {showEffort(mentorReasoningEffort) && <Text color={theme.warning}> {mentorReasoningEffort}</Text>}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

/** The speaker is a chip; the text hangs beside it, so a wrapped message keeps its left edge. */
export const LedgerUserMessage: FC<UserMessageView> = ({ text }) => {
  const theme = useTheme();
  return (
    <Box width="100%">
      <Box flexShrink={0}>
        <Chip tone="accent" bold>
          YOU
        </Chip>
      </Box>
      <Box marginLeft={1} flexShrink={1}>
        <Text bold color={theme.userText}>
          {text}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * A label chip on its own line above the text, so the markdown keeps the full
 * width (`assistantGutter` is 0). Reasoning gets a quiet chip, the answer a solid one.
 */
export const LedgerAssistantFrame: FC<AssistantFrameProps> = ({ kind, children }) => (
  <Box flexDirection="column">
    {kind === 'answer' ? (
      <Chip solid tone="accent">
        TERM²
      </Chip>
    ) : (
      <Chip tone="textMuted">THINKING</Chip>
    )}
    {children}
  </Box>
);
