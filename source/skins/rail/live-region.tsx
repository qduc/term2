import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import type { HintsProps, InputFrameProps, PromptMarkerProps, WorkingIndicatorView } from '../types.js';
import { Hairline, cells } from './parts.js';

const INTERRUPT_HINT = 'esc to interrupt';

/** The spinner glyph. Its own component so only this cell re-renders on each tick. */
const WorkingGlyph: FC = () => {
  const theme = useTheme();
  const frame = useSpinnerFrame(BRAILLE_SPINNER);
  return <Text color={theme.accent}>{frame}</Text>;
};

interface WorkingLabel {
  before: string;
  /** The tool's name, drawn bold. */
  strong?: string;
  after: string;
}

/** What the agent is doing, as the text of one line: `Thinking… 12s`. */
function workingLabel(view: WorkingIndicatorView): WorkingLabel {
  const { phase, elapsedSeconds, tokensPerSecond, toolName, argumentChars } = view;
  const rate = tokensPerSecond != null && tokensPerSecond > 0 ? formatTokensPerSecond(tokensPerSecond) : undefined;

  if (phase === 'tool_call') {
    const detail = [argumentChars != null ? `${argumentChars} chars` : undefined, rate].filter(Boolean).join(' · ');
    return {
      before: toolName ? 'Calling tool ' : 'Calling tool',
      strong: toolName,
      after: `… ${elapsedSeconds}s${detail ? ` (${detail})` : ''}`,
    };
  }
  if (phase === 'thinking') return { before: `Thinking… ${elapsedSeconds}s${rate ? ` (${rate})` : ''}`, after: '' };
  if (rate) return { before: `Generating… ${elapsedSeconds}s (${rate})`, after: '' };
  return { before: `Processing… ${elapsedSeconds}s`, after: '' };
}

/**
 * `⠋ Thinking… 12s   esc to interrupt`. The interrupt hint is decoration: it is
 * the first thing dropped when the line would not fit.
 */
export const RailWorkingIndicator: FC<WorkingIndicatorView> = (view) => {
  const theme = useTheme();
  const columns = useTerminalColumns();
  const { before, strong, after } = workingLabel(view);
  const width = 2 + cells(before) + cells(strong ?? '') + cells(after) + 3 + cells(INTERRUPT_HINT);
  const showHint = width <= columns;

  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <WorkingGlyph />
      </Box>
      <Box flexShrink={1}>
        <Text color={theme.textMuted}>
          {before}
          {strong !== undefined && <Text bold>{strong}</Text>}
          {after}
          {showHint && <Text color={theme.textSubtle}>{`   ${INTERRUPT_HINT}`}</Text>}
        </Text>
      </Box>
    </Box>
  );
};

/** Above the live region: one hairline between printed history and the controls. */
export const RailLiveDivider: FC = () => <Hairline />;

export const RailPromptMarker: FC<PromptMarkerProps> = ({ mode }) => {
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

/** The prompt sits between two hairlines: the live divider above, this one below. */
export const RailInputFrame: FC<InputFrameProps> = ({ children }) => (
  <Box flexDirection="column">
    <Box>{children}</Box>
    <Hairline />
  </Box>
);

/**
 * `⏎ steer · alt+⏎ queue · / commands`: dim, joined by middle dots. Keys are one
 * step brighter than the words they name, or in their own role colour when the
 * container gave one. Whole hints wrap, never the middle of one.
 */
export const RailHints: FC<HintsProps> = ({ hints }) => {
  const theme = useTheme();
  return (
    <Box flexWrap="wrap" columnGap={1}>
      {hints.map(([key, action, keyColor], index) => (
        <Text key={key} color={theme.textSubtle}>
          <Text color={keyColor ? theme[keyColor] : theme.textMuted}>{key}</Text> {action}
          {index < hints.length - 1 ? ' ·' : ''}
        </Text>
      ))}
    </Box>
  );
};
