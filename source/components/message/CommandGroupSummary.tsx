import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { countFailedMembers, summarizeCommandGroup, type GroupableMessage } from './command-grouping.js';

const COLOR_SUCCESS = '#A0A0A0';
const COLOR_ERROR = 'red';

type Props = {
  members: GroupableMessage[];
  hasFailure: boolean;
};

/** Concise-mode single line for a closed run of tool calls, e.g. "Searched for 1 pattern, read 3 files, ran 2 shell commands". */
const CommandGroupSummary: FC<Props> = ({ members, hasFailure }) => {
  const summary = summarizeCommandGroup(members);
  const failedCount = hasFailure ? countFailedMembers(members) : 0;

  return (
    <Box>
      <Text color={hasFailure ? COLOR_ERROR : COLOR_SUCCESS}>
        <Text color={hasFailure ? COLOR_ERROR : 'green'} bold>
          {hasFailure ? '✖' : '✔'}
        </Text>{' '}
        {summary}
        {failedCount > 0 && <Text color={COLOR_ERROR}> ({failedCount} failed)</Text>}
      </Text>
    </Box>
  );
};

export default React.memo(CommandGroupSummary);
