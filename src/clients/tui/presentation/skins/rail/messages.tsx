import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { MODEL_LABEL_MAX } from '../shared/limits.js';
import type { AssistantFrameProps, BannerView, UserMessageView } from '../types.js';
import { cells } from './parts.js';

const truncateModel = (name: string): string =>
  name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;

/**
 * One line, no box: `term² v0.30.0 · Codex/gpt-5.6-luna (high)`, with provider and effort.
 * On a narrow terminal the version is the first
 * thing to go, and if the rest still does not fit the model moves to its own line.
 */
export const RailBanner: FC<BannerView> = ({ version, providerLabel, model, reasoningEffort }) => {
  const theme = useTheme();
  const columns = useTerminalColumns();

  const effort = reasoningEffort !== 'none' ? ` (${reasoningEffort})` : '';
  const modelText = `${providerLabel}/${model ? truncateModel(model) : '—'}${effort}`;
  const versionText = `v${version}`;

  const brandWidth = cells('term²');
  const tailWidth = 3 + cells(modelText);
  const withVersion = brandWidth + 1 + cells(versionText) + tailWidth;
  const showVersion = withVersion <= columns;
  const oneLine = showVersion || brandWidth + tailWidth <= columns;

  const brand = (
    <>
      <Text color={theme.accent} bold>
        term²
      </Text>
      {showVersion && <Text color={theme.textMuted}> {versionText}</Text>}
    </>
  );
  const separator = <Text color={theme.textSubtle}> · </Text>;
  const modelNode = (
    <>
      <Text color={theme.textMuted}>{providerLabel}</Text>
      <Text color={theme.textSubtle}>/</Text>
      <Text color={theme.accent}>{model ? truncateModel(model) : '—'}</Text>
      {effort && <Text color={theme.textSubtle}>{effort}</Text>}
    </>
  );
  if (oneLine) {
    return (
      <Box marginBottom={1}>
        <Text>
          {brand}
          {separator}
          {modelNode}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{brand}</Text>
      <Text>{modelNode}</Text>
    </Box>
  );
};

/**
 * No background band: a band only works against the terminal background it was
 * tuned for, whereas bold text behind an accent prompt reads on any. A long
 * message wraps under its first word, not under the `❯`.
 */
export const RailUserMessage: FC<UserMessageView> = ({ text }) => {
  const theme = useTheme();
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={theme.accent} bold>
          ❯
        </Text>
      </Box>
      <Box flexShrink={1}>
        <Text bold color={theme.userText}>
          {text}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Answers and reasoning are printed bare, flush left. Reasoning is already
 * quieter (its own colour from the container), and indenting only it would need
 * a gutter that `assistantGutter` cannot declare per kind.
 */
export const RailAssistantFrame: FC<AssistantFrameProps> = ({ children }) => <>{children}</>;
