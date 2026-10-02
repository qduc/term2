import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { describeGroupFailures, summarizeCommandGroup, type GroupableMessage } from './command-grouping.js';
import { TOOL_STATUS_GLYPH, type ToolStatusKind, useTheme } from '../theme.js';

type Props = {
  members: GroupableMessage[];
  status: 'completed' | 'partial' | 'failed';
};

// A partly-failed run keeps a green marker and neutral summary: most of what it
// did succeeded, and painting the whole line red would claim otherwise. The red
// marker underneath carries the bad news, and names the calls that failed so the
// count is actionable without painting the entire line red.
const MARKER_KIND: Record<Props['status'], ToolStatusKind> = {
  completed: 'completed',
  partial: 'completed',
  failed: 'failed',
};

/** Concise-mode line(s) for a run of tool calls, e.g. "Searched for 1 pattern, read 3 files, ran 2 shell commands". */
const CommandGroupSummary: FC<Props> = ({ members, status }) => {
  const theme = useTheme();
  const summary = summarizeCommandGroup(members);
  const failures = describeGroupFailures(members);
  const kind = MARKER_KIND[status];
  const marker = TOOL_STATUS_GLYPH[kind];
  const markerColor = theme.toolStatus[kind];
  const textColor = theme.textMuted;

  return (
    <Box flexDirection="column">
      <Text color={textColor} wrap="truncate">
        <Text color={markerColor} bold>
          {marker}
        </Text>{' '}
        {summary}
      </Text>
      {failures !== '' && status !== 'failed' && (
        <Text color={theme.textMuted} wrap="truncate">
          <Text color={theme.toolStatus.failed} bold>
            {TOOL_STATUS_GLYPH.failed}
          </Text>{' '}
          {failures}
        </Text>
      )}
    </Box>
  );
};

export default React.memo(CommandGroupSummary);
