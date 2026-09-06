import React, { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { truncateOutputLines, type RunCodeTrace } from './command-message-helpers.js';
import {
  COLOR_DANGER,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SUBTLE,
  COLOR_TOOL_OUTPUT,
  TOOL_STATUS_COLOR,
  TOOL_STATUS_GLYPH,
} from '../theme.js';

type Props = {
  trace: RunCodeTrace;
  success?: boolean | null;
  renderStandardHeader: () => ReactNode;
};

/**
 * Renders a `run_code` card as the work it did: one row per tool the script
 * called, then whatever the script returned. Without the rows a script reads as
 * an opaque blob, since its nested calls otherwise appear only as a count on the
 * last line of the result.
 */
const RunCodeRenderer: React.FC<Props> = ({ trace, success, renderStandardHeader }) => (
  <Box flexDirection="column">
    {renderStandardHeader()}
    {trace.rows.length > 0 && (
      <Box flexDirection="column" paddingLeft={2}>
        {trace.rows.map((row) => (
          <Text key={row.tool} color={COLOR_TEXT_MUTED}>
            <Text color={TOOL_STATUS_COLOR[row.status]}>{TOOL_STATUS_GLYPH[row.status]}</Text> {row.tool}
            {row.count > 1 ? <Text color={COLOR_TEXT_SUBTLE}> ×{row.count}</Text> : null}
            {row.note ? <Text color={COLOR_DANGER}> — {row.note}</Text> : null}
          </Text>
        ))}
      </Box>
    )}
    {trace.body ? (
      <Text color={success === false ? COLOR_DANGER : COLOR_TOOL_OUTPUT}>{truncateOutputLines(trace.body)}</Text>
    ) : null}
  </Box>
);

export default RunCodeRenderer;
