import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import type { HintsProps, InputFrameProps, PromptMarkerProps, WorkingIndicatorView } from '../types.js';
import { Card } from './card.js';

/** The only animated piece of the live region; it exists to keep the ticking out of its parent. */
const Spinner: FC = () => {
  const theme = useTheme();
  const frame = useSpinnerFrame(BRAILLE_SPINNER, true);
  return (
    <Text color={theme.accent} bold>
      {frame}
    </Text>
  );
};

/** Spinner, then what the agent is doing and for how long. The same facts the classic line gives. */
export const CardsWorkingIndicator: FC<WorkingIndicatorView> = ({
  phase,
  elapsedSeconds,
  tokensPerSecond,
  toolName,
  argumentChars,
}) => {
  const theme = useTheme();
  const hasRate = tokensPerSecond != null && tokensPerSecond > 0;
  const rate = hasRate ? formatTokensPerSecond(tokensPerSecond) : '';

  let label: React.ReactNode;
  if (phase === 'tool_call') {
    label = (
      <>
        Calling tool {toolName ? <Text bold>{toolName}</Text> : ''}
        {' · '}
        {elapsedSeconds}s{argumentChars != null ? ` (${argumentChars} chars` : ''}
        {hasRate ? ` · ${rate}` : ''}
        {argumentChars != null ? ')' : ''}
      </>
    );
  } else if (phase === 'thinking') {
    label = (
      <>
        Thinking · {elapsedSeconds}s{hasRate ? ` (${rate})` : ''}
      </>
    );
  } else {
    label = hasRate ? `Generating · ${elapsedSeconds}s (${rate})` : `Processing · ${elapsedSeconds}s`;
  }

  return (
    <Box>
      <Box flexShrink={0} marginRight={1}>
        <Spinner />
      </Box>
      <Box flexShrink={1}>
        <Text color={theme.textSubtle}>{label}</Text>
      </Box>
    </Box>
  );
};

/** The input card is the structure, so there is no rule between history and the live controls. */
export const CardsLiveDivider: FC = () => null;

export const CardsPromptMarker: FC<PromptMarkerProps> = ({ mode }) => {
  const theme = useTheme();
  if (mode === 'rejection') {
    return (
      <Text color={theme.warning} bold>
        Why?{' '}
      </Text>
    );
  }
  if (mode === 'shell') {
    return (
      <Text color={theme.danger} bold>
        !{' '}
      </Text>
    );
  }
  return (
    <Text color={theme.accent} bold>
      ❯{' '}
    </Text>
  );
};

/**
 * A rounded card around the marker and the editable input, drawn in the active-border
 * colour. The input sizes itself to the terminal width less four columns, which is
 * exactly what a border and a column of padding on each side take.
 */
export const CardsInputFrame: FC<InputFrameProps> = ({ children }) => {
  const theme = useTheme();
  return (
    <Card color={theme.borderActive}>
      <Box>{children}</Box>
    </Card>
  );
};

/** Quiet key hints, `·`-separated, with the key itself carrying the weight. */
export const CardsHints: FC<HintsProps> = ({ hints }) => {
  const theme = useTheme();
  return (
    <Text color={theme.textSubtle}>
      {hints.map(([key, action, keyColor], index) => (
        <React.Fragment key={key}>
          {index > 0 ? ' · ' : ''}
          <Text color={keyColor ? theme[keyColor] : theme.textMuted} bold>
            {key}
          </Text>{' '}
          {action}
        </React.Fragment>
      ))}
    </Text>
  );
};
