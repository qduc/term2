import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { describeGroupFailures, summarizeCommandGroup, type GroupableMessage } from './command-grouping.js';

const COLOR_SUCCESS = '#A0A0A0';
const COLOR_ERROR = 'red';

type Props = {
  members: GroupableMessage[];
  status: 'completed' | 'partial' | 'failed';
};

// A partly-failed run keeps a green marker and neutral summary: most of what it
// did succeeded, and painting the whole line red would claim otherwise. The red
// line underneath carries the bad news, and names the calls that failed so the
// count is actionable. Only an entirely-failed run turns red.
const MARKERS: Record<Props['status'], { marker: string; markerColor: string; textColor: string }> = {
  completed: { marker: '✔', markerColor: 'green', textColor: COLOR_SUCCESS },
  partial: { marker: '✔', markerColor: 'green', textColor: COLOR_SUCCESS },
  failed: { marker: '✖', markerColor: COLOR_ERROR, textColor: COLOR_ERROR },
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
          <Text color={COLOR_ERROR} wrap="truncate">
            ✖ {failures}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default React.memo(CommandGroupSummary);
