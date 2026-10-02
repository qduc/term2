import React, { type FC } from 'react';
import { Box, Text, useStdout } from 'ink';
import Divider from '../../components/common/Divider.js';
import { useTheme } from '../../components/theme.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import type { HintsProps, InputFrameProps, PromptMarkerProps, WorkingIndicatorView } from '../types.js';

/** The only animated piece of the working line. Mounted only while the indicator is. */
const WorkingSpinner: FC = () => {
  const theme = useTheme();
  const frame = useSpinnerFrame(BRAILLE_SPINNER, true);
  return (
    <Text color={theme.accent} bold>
      {frame}
    </Text>
  );
};

const INTERRUPT_HINT = 'esc to interrupt';

const PHASE_LABEL: Record<WorkingIndicatorView['phase'], string> = {
  thinking: 'Thinking',
  generating: 'Generating',
  processing: 'Processing',
  tool_call: 'Calling tool',
};

/** `⠋ Thinking  12s · 48.2 tok/s · esc to interrupt`: a label, then the facts, dimmed. */
export const LedgerWorkingIndicator: FC<WorkingIndicatorView> = ({
  phase,
  elapsedSeconds,
  tokensPerSecond,
  toolName,
  argumentChars,
}) => {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 100;
  const hasRate = tokensPerSecond != null && tokensPerSecond > 0;

  const details: string[] = [`${elapsedSeconds}s`];
  if (phase === 'tool_call' && argumentChars != null) details.push(`${argumentChars} chars`);
  if (hasRate) details.push(formatTokensPerSecond(tokensPerSecond));

  // The interrupt hint is a reminder, the facts before it are not: it goes first when the
  // line would not fit (spinner and gap take 2 columns).
  const factsWidth = [PHASE_LABEL[phase], toolName ?? '', ...details].join(' · ').length + 2;
  if (factsWidth + INTERRUPT_HINT.length + 3 <= columns) details.push(INTERRUPT_HINT);

  return (
    <Box>
      <Box flexShrink={0} marginRight={1}>
        <WorkingSpinner />
      </Box>
      <Box flexShrink={1}>
        <Text wrap="wrap">
          <Text color={theme.accent} bold>
            {PHASE_LABEL[phase]}
          </Text>
          {phase === 'tool_call' && toolName ? (
            <Text color={theme.text} bold>
              {' '}
              {toolName}
            </Text>
          ) : null}
          <Text color={theme.textSubtle}> {details.join(' · ')}</Text>
        </Text>
      </Box>
    </Box>
  );
};

/** A plain rule: the one structural split between printed history and the live controls. */
export const LedgerLiveDivider: FC = () => <Divider />;

/**
 * The marker is a small solid tab exactly as wide as the container budgeted for it
 * (2 columns, 5 for the rejection prompt), so the input's wrap width stays right.
 */
export const LedgerPromptMarker: FC<PromptMarkerProps> = ({ mode }) => {
  const theme = useTheme();
  if (mode === 'rejection') {
    return (
      <Text inverse bold color={theme.warning}>
        Why?{' '}
      </Text>
    );
  }
  if (mode === 'shell') {
    return (
      <Text inverse bold color={theme.danger}>
        !{' '}
      </Text>
    );
  }
  return (
    <Text inverse bold color={theme.accent}>
      ❯{' '}
    </Text>
  );
};

/**
 * The prompt row sits on a full-width band. The marker is flush left like a tab; a
 * one-cell gap and a one-cell right margin together use 2 of the 4 spare columns
 * the container reserves for horizontal padding, so the input never overflows.
 */
export const LedgerInputFrame: FC<InputFrameProps> = ({ children }) => {
  const theme = useTheme();
  return (
    <Box width="100%" backgroundColor={theme.codeBackground} columnGap={1} paddingRight={1}>
      {children}
    </Box>
  );
};

/** Dim and compact: bold keys, quiet actions, two spaces between pairs. */
export const LedgerHints: FC<HintsProps> = ({ hints }) => {
  const theme = useTheme();
  return (
    <Text color={theme.textSubtle} wrap="wrap">
      {hints.map(([key, action, keyColor], index) => (
        <React.Fragment key={`${key}-${index}`}>
          {index > 0 ? '  ' : ''}
          <Text bold color={keyColor ? theme[keyColor] : theme.textMuted}>
            {key}
          </Text>{' '}
          {action}
        </React.Fragment>
      ))}
    </Text>
  );
};
