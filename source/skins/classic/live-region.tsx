import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import Divider from '../../components/common/Divider.js';
import { GLYPH_SEPARATOR, useTheme } from '../../components/theme.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
import type { HintsProps, InputFrameProps, PromptMarkerProps, WorkingIndicatorView } from '../types.js';

/** What the agent is doing right now, as a single muted line. */
export const ClassicWorkingIndicator: FC<WorkingIndicatorView> = ({
  phase,
  elapsedSeconds,
  tokensPerSecond,
  toolName,
  argumentChars,
  dotCount,
}) => {
  const theme = useTheme();
  const hasRate = tokensPerSecond != null && tokensPerSecond > 0;

  if (phase === 'tool_call') {
    return (
      <Text color={theme.textSubtle}>
        Calling tool {toolName ? <Text bold>{toolName}</Text> : ''}
        {' · '}
        {elapsedSeconds}s{argumentChars != null ? ` (${argumentChars} chars` : ''}
        {hasRate ? ` · ${formatTokensPerSecond(tokensPerSecond)}` : ''}
        {argumentChars != null ? ')' : ''}
        {'.'.repeat(dotCount)}
      </Text>
    );
  }

  if (phase === 'thinking') {
    return (
      <Text color={theme.textSubtle}>
        Thinking · {elapsedSeconds}s{hasRate ? ` (${formatTokensPerSecond(tokensPerSecond)})` : ''}
      </Text>
    );
  }

  return (
    <Text color={theme.textSubtle}>
      {hasRate
        ? `Generating · ${elapsedSeconds}s (${formatTokensPerSecond(tokensPerSecond)})`
        : `Processing · ${elapsedSeconds}s`}
    </Text>
  );
};

/** The one structural split on screen: printed history above, live controls below. */
export const ClassicLiveDivider: FC = () => <Divider />;

export const ClassicPromptMarker: FC<PromptMarkerProps> = ({ mode }) => {
  const theme = useTheme();
  if (mode === 'rejection') return <Text color={theme.warning}>Why? </Text>;
  if (mode === 'shell') return <Text color={theme.danger}>! </Text>;
  return <Text color={theme.accent}>❯ </Text>;
};

/** The input row is printed bare; the frame is the seam other skins draw a box or rule around. */
export const ClassicInputFrame: FC<InputFrameProps> = ({ children }) => <Box>{children}</Box>;

/**
 * One footer format for every menu and for the input, so the reader learns the
 * shape once: `key action │ key action`. Menus used to each invent their own
 * wording, separator, and arrow glyph.
 */
export const ClassicHints: FC<HintsProps> = ({ hints }) => {
  const theme = useTheme();
  return (
    <Text color={theme.textSubtle}>
      {hints.map(([key, action, keyColor], index) => (
        <React.Fragment key={key}>
          {index > 0 ? ` ${GLYPH_SEPARATOR} ` : ''}
          {keyColor ? <Text color={theme[keyColor]}>{key}</Text> : key} {action}
        </React.Fragment>
      ))}
    </Text>
  );
};
