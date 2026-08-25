import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { countFailedMembers, summarizeCommandGroup, type GroupableMessage } from './command-grouping.js';

const COLOR_SUCCESS = '#A0A0A0';
const COLOR_ERROR = 'red';
const COLOR_WARNING = 'yellow';

type Props = {
  members: GroupableMessage[];
  /** `running` while the run may still grow; the counts keep ticking up in place. */
  status: 'running' | 'completed' | 'failed';
};

/** Concise-mode single line for a run of tool calls, e.g. "Searched for 1 pattern, read 3 files, ran 2 shell commands". */
const CommandGroupSummary: FC<Props> = ({ members, status }) => {
  const summary = summarizeCommandGroup(members);
  const hasFailure = status === 'failed';
  const failedCount = hasFailure ? countFailedMembers(members) : 0;
  const color = hasFailure ? COLOR_ERROR : status === 'running' ? COLOR_WARNING : COLOR_SUCCESS;
  const marker = hasFailure ? '✖' : status === 'running' ? '▶' : '✔';
  const markerColor = hasFailure ? COLOR_ERROR : status === 'running' ? COLOR_WARNING : 'green';

  return (
    <Box>
      <Text color={color}>
        <Text color={markerColor} bold>
          {marker}
        </Text>{' '}
        {summary}
        {failedCount > 0 && <Text color={COLOR_ERROR}> ({failedCount} failed)</Text>}
      </Text>
    </Box>
  );
};

export default React.memo(CommandGroupSummary);
