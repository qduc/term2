import React, { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { truncateOutputLines, type RunCodeTrace } from './command-message-helpers.js';
import { TOOL_STATUS_GLYPH, useTheme } from '../theme.js';

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
const RunCodeRenderer: React.FC<Props> = ({ trace, success, renderStandardHeader }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {renderStandardHeader()}
      {trace.rows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {trace.rows.map((row) => (
            <Text key={row.tool} color={theme.textMuted}>
              <Text color={theme.toolStatus[row.status]}>{TOOL_STATUS_GLYPH[row.status]}</Text> {row.tool}
              {row.count > 1 ? <Text color={theme.textSubtle}> ×{row.count}</Text> : null}
              {row.note ? <Text color={theme.danger}> — {row.note}</Text> : null}
            </Text>
          ))}
        </Box>
      )}
      {trace.body ? (
        <Text color={success === false ? theme.danger : theme.toolOutput}>{truncateOutputLines(trace.body)}</Text>
      ) : null}
    </Box>
  );
};

export default RunCodeRenderer;
