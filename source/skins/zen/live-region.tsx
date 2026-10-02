import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { DOT_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import type { HintsProps, InputFrameProps, PromptMarkerProps, WorkingIndicatorView } from '../types.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';

/** Short waits stay calm: a count only appears once the wait is long enough to wonder about. */
const SHOW_ELAPSED_AFTER_SECONDS = 10;

const labelFor = ({ phase, toolName }: Pick<WorkingIndicatorView, 'phase' | 'toolName'>): string => {
  switch (phase) {
    case 'thinking':
      return 'thinking';
    case 'generating':
      return 'writing';
    case 'tool_call':
      return toolName ? `using ${toolName}` : 'calling a tool';
    default:
      return 'working';
  }
};

/** The breathing dots. Their own component so only these three cells re-render on each tick. */
const BreathingDots: FC = () => {
  const frame = useSpinnerFrame(DOT_SPINNER, true, 300);
  return <Text>{frame}</Text>;
};

/**
 * `◆ thinking ···`: the answer's own marker, dimmed, with a slow breath beside
 * what is happening. The `◆` is the one thing that does not move, so the line
 * reads as "the next answer is on its way" even in a terminal that shows no colour.
 */
export const ZenWorkingIndicator: FC<WorkingIndicatorView> = (view) => {
  const theme = useTheme();
  const { faint } = useZenStyles();
  return (
    <Box paddingLeft={MARKER_COLUMNS}>
      <Text {...faint}>
        <Text color={theme.accent}>◆</Text> {labelFor(view)} <BreathingDots />
        {view.elapsedSeconds >= SHOW_ELAPSED_AFTER_SECONDS ? ` ${view.elapsedSeconds}s` : ''}
      </Text>
    </Box>
  );
};

/** Whitespace is the divider; the live controls are already set off by the blank line above them. */
export const ZenLiveDivider: FC = () => null;

/** The marker is the whole identity of the input: `›` to talk, `!` to run, a question after a refusal. */
export const ZenPromptMarker: FC<PromptMarkerProps> = ({ mode }) => {
  const theme = useTheme();
  if (mode === 'rejection') {
    return (
      <Text color={theme.warning} bold>
        why?{' '}
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
      ›{' '}
    </Text>
  );
};

/** Borderless: the input is a line like any other, which is what keeps the page calm. */
export const ZenInputFrame: FC<InputFrameProps> = ({ children }) => <Box>{children}</Box>;

/**
 * Every hint is kept; they are only made small. Keys sit one step above their
 * verbs so the eye can find `esc` without reading the line, and the whole line is
 * the dimmest text on screen.
 */
export const ZenHints: FC<HintsProps> = ({ hints }) => {
  const theme = useTheme();
  const { quiet, faint } = useZenStyles();
  return (
    <Text {...faint}>
      {hints.map(([key, action, keyColor], index) => (
        <React.Fragment key={`${key}:${action}`}>
          {index > 0 ? ' · ' : ''}
          {keyColor ? <Text color={theme[keyColor]}>{key}</Text> : <Text {...quiet}>{key}</Text>} {action}
        </React.Fragment>
      ))}
    </Text>
  );
};
