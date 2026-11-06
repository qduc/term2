import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
import type { ToolStatusKind } from '../../theme/palettes.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import type { ToolFrameProps, ToolGroupSummaryView, ToolHeaderProps } from '../types.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';

/**
 * Tool calls sit under the answer's text column, indented by the width of the
 * `◆` marker, so a turn reads as one column of prose with the machinery tucked
 * into it. The frame wraps header and body together (the container composes
 * them), so the indent is all it can do; the header decides everything else.
 */
export const ZenToolFrame: FC<ToolFrameProps> = ({ children }) => (
  <Box flexDirection="column" paddingLeft={MARKER_COLUMNS}>
    {children}
  </Box>
);

const isTrouble = (status: ToolStatusKind): boolean => status === 'failed' || status === 'rejected';

/** The glyph of a call in flight. A component of its own so only this cell re-renders on each tick. */
const RunningGlyph: FC = () => {
  const theme = useTheme();
  const frame = useSpinnerFrame(BRAILLE_SPINNER, true, 120);
  return <Text color={theme.warning}>{frame}</Text>;
};

const StatusGlyph: FC<{ status: ToolStatusKind }> = ({ status }) => {
  const theme = useTheme();
  const { faint } = useZenStyles();
  if (status === 'running') return <RunningGlyph />;
  if (isTrouble(status)) {
    return (
      <Text color={theme.toolStatus[status]} bold>
        {TOOL_STATUS_GLYPH[status]}
      </Text>
    );
  }
  // Settled and waiting calls are furniture: the glyph is there to be scanned, not to be coloured.
  return <Text {...faint}>{TOOL_STATUS_GLYPH[status]}</Text>;
};

/**
 * One quiet line. Colour is spent only on trouble: a failed call is red from its
 * glyph to its last word, everything that went right recedes. A running call is
 * the one other thing allowed to stand out, with a small spinner in the warning
 * tone, because it is the one thing still happening.
 */
export const ZenToolHeader: FC<ToolHeaderProps> = ({ status, display, nested, action, meta, trailing, textColor }) => {
  const theme = useTheme();
  const { quiet, faint, colourless } = useZenStyles();
  const inFlight = status === 'running' || status === 'pending';

  if (nested) {
    return (
      <Box>
        <Text wrap="truncate" {...faint}>
          <StatusGlyph status={status} /> {action}
          {meta}
        </Text>
      </Box>
    );
  }

  // Standard display prints the output underneath, so the header is the brighter
  // of the two; concise display is the whole record, so it recedes.
  const actionStyle =
    status === 'failed'
      ? { color: theme.danger, dimColor: false, bold: colourless }
      : display === 'standard' || inFlight
      ? { color: undefined, dimColor: false }
      : { ...quiet, color: textColor || quiet.color };

  return (
    <Box>
      <Box width={MARKER_COLUMNS} flexShrink={0}>
        <StatusGlyph status={status} />
      </Box>
      <Text {...actionStyle}>
        {action}
        {meta}
        {trailing}
      </Text>
    </Box>
  );
};

/**
 * One quiet line for a run of calls, and, only when something failed, the failing
 * calls beneath it, in the danger tone. A partly failed run keeps a calm summary:
 * most of it worked, and the line below says exactly what did not.
 */
export const ZenToolGroupSummary: FC<ToolGroupSummaryView> = ({ status, summary, failures }) => {
  const theme = useTheme();
  const { quiet, faint, colourless } = useZenStyles();
  return (
    <Box flexDirection="column" paddingLeft={MARKER_COLUMNS} width="100%">
      <Box>
        <Box width={MARKER_COLUMNS} flexShrink={0}>
          {status === 'failed' ? (
            <Text color={theme.toolStatus.failed} bold>
              {TOOL_STATUS_GLYPH.failed}
            </Text>
          ) : (
            <Text {...faint}>{TOOL_STATUS_GLYPH.completed}</Text>
          )}
        </Box>
        <Text {...quiet}>{summary}</Text>
      </Box>
      {failures !== '' && (
        <Box>
          <Box width={MARKER_COLUMNS} flexShrink={0}>
            <Text color={theme.toolStatus.failed} bold>
              {TOOL_STATUS_GLYPH.failed}
            </Text>
          </Box>
          <Text color={theme.danger} bold={colourless}>
            {failures}
          </Text>
        </Box>
      )}
    </Box>
  );
};
