import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { MODEL_LABEL_MAX } from '../shared/limits.js';
import type { AssistantFrameProps, BannerView, UserMessageView } from '../types.js';
import { Card } from './card.js';

/**
 * Columns the assistant frame may take on the left: the reasoning rail and its space.
 * Declared for both kinds, so an answer wraps two columns narrower than it strictly needs
 * to; that is the price of one honest number, and it keeps reasoning's code blocks inside
 * the terminal.
 */
export const ASSISTANT_GUTTER = 2;

const truncateModel = (name: string): string =>
  name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;

/**
 * A small card that shrinks to its content: name and version on the border, the
 * provider, model and reasoning effort on the first row.
 */
export const CardsBanner: FC<BannerView> = ({ version, providerLabel, model, reasoningEffort }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingTop={1} marginBottom={1}>
      <Card
        fit
        color={theme.border}
        title={
          <Text wrap="truncate-end">
            <Text color={theme.accent} bold>
              term²
            </Text>
            <Text color={theme.textMuted}> v{version}</Text>
          </Text>
        }
      >
        <Text>
          <Text color={theme.textMuted}>{providerLabel}</Text>
          <Text color={theme.textSubtle}>/</Text>
          <Text color={theme.accent} bold>
            {model ? truncateModel(model) : '—'}
          </Text>
          {reasoningEffort !== 'none' && <Text color={theme.textSubtle}> ({reasoningEffort})</Text>}
        </Text>
      </Card>
    </Box>
  );
};

/** The user's turn in a card of its own, in the accent colour, titled `you`. */
export const CardsUserMessage: FC<UserMessageView> = ({ text }) => {
  const theme = useTheme();
  return (
    <Card
      color={theme.accent}
      title={
        <Text color={theme.accent} bold wrap="truncate-end">
          you
        </Text>
      }
    >
      <Text color={theme.userText}>{text}</Text>
    </Card>
  );
};

const REASONING_RAIL = {
  topLeft: '',
  top: '',
  topRight: '',
  left: '┆',
  bottomLeft: '',
  bottom: '',
  bottomRight: '',
  right: '',
};

/**
 * Answers stay completely bare, flush left, so long markdown and code blocks read
 * without a frame. Reasoning is subordinate: it sits behind a quiet dotted rail, which is
 * also what marks it apart from an answer when there is no colour.
 */
export const CardsAssistantFrame: FC<AssistantFrameProps> = ({ kind, children }) => {
  const theme = useTheme();
  if (kind === 'reasoning') {
    return (
      <Box
        flexDirection="column"
        borderStyle={REASONING_RAIL}
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderColor={theme.textSubtle}
        paddingLeft={1}
      >
        {children}
      </Box>
    );
  }
  return <>{children}</>;
};
