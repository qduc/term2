import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { describeGroupFailures, summarizeCommandGroup, type GroupableMessage } from './command-grouping.js';
import { COLOR_DANGER, COLOR_TEXT_MUTED, TOOL_STATUS_COLOR, TOOL_STATUS_GLYPH } from '../theme.js';

type Props = {
  members: GroupableMessage[];
  status: 'completed' | 'partial' | 'failed';
};

// A partly-failed run keeps a green marker and neutral summary: most of what it
// did succeeded, and painting the whole line red would claim otherwise. The red
// line underneath carries the bad news, and names the calls that failed so the
// count is actionable. Only an entirely-failed run turns red.
const MARKERS: Record<Props['status'], { marker: string; markerColor: string; textColor: string }> = {
  completed: {
    marker: TOOL_STATUS_GLYPH.completed,
    markerColor: TOOL_STATUS_COLOR.completed,
    textColor: COLOR_TEXT_MUTED,
  },
  partial: {
    marker: TOOL_STATUS_GLYPH.completed,
    markerColor: TOOL_STATUS_COLOR.completed,
    textColor: COLOR_TEXT_MUTED,
  },
  failed: { marker: TOOL_STATUS_GLYPH.failed, markerColor: TOOL_STATUS_COLOR.failed, textColor: COLOR_DANGER },
};

/** Concise-mode line(s) for a run of tool calls, e.g. "Searched for 1 pattern, read 3 files, ran 2 shell commands". */
const CommandGroupSummary: FC<Props> = ({ members, status }) => {
  const summary = summarizeCommandGroup(members);
  const failures = describeGroupFailures(members);
  const { marker, markerColor, textColor } = MARKERS[status];

  return (
    <Box flexDirection="column">
      <Text color={textColor} wrap="truncate">
        <Text color={markerColor} bold>
          {marker}
        </Text>{' '}
        {summary}
      </Text>
      {failures !== '' && status !== 'failed' && (
        <Box paddingLeft={2}>
          <Text color={COLOR_DANGER} wrap="truncate">
            {TOOL_STATUS_GLYPH.failed} {failures}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default React.memo(CommandGroupSummary);
