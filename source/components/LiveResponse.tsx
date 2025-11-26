import React, {FC} from 'react';
import {Box} from 'ink';
import MarkdownRenderer from './MarkdownRenderer.js';

type Props = {
  text?: string;
};

const LiveResponse: FC<Props> = ({text}) => {
  return (
    <Box marginBottom={1} flexDirection="column">
      <MarkdownRenderer>{text || ' '}</MarkdownRenderer>
    </Box>
  );
};

export default LiveResponse;
