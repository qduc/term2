import React, {FC} from 'react';
import {Box, Text} from 'ink';

type Props = {
  approval: any;
};

const ApprovalPrompt: FC<Props> = ({approval}) => {
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        {approval.agentName} wants to run: <Text bold>{approval.toolName}</Text>
      </Text>
      <Text dimColor>{approval.argumentsText}</Text>
      <Text>
        <Text color="yellow">(y/n)</Text>
      </Text>
    </Box>
  );
};

export default ApprovalPrompt;
