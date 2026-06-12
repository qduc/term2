import React, { FC } from 'react';
import { Box, Text } from 'ink';
import MarkdownRenderer from '../MarkdownRenderer.js';
import { COLOR_REASONING } from '../theme.js';

type Props = {
  msg: any;
  maxWidth?: number;
};

const ChatMessage: FC<Props> = ({ msg, maxWidth }) => {
  return (
    <Box flexDirection="column">
      {msg.sender === 'user' ? (
        <Text color="#22d3ee">❯ {msg.text}</Text>
      ) : msg.sender === 'system' ? (
        <Text color={COLOR_REASONING}>{msg.text}</Text>
      ) : msg.sender === 'reasoning' ? (
        <MarkdownRenderer defaultColor={COLOR_REASONING} maxWidth={maxWidth}>
          {msg.text}
        </MarkdownRenderer>
      ) : (
        <MarkdownRenderer maxWidth={maxWidth}>{msg.text}</MarkdownRenderer>
      )}
    </Box>
  );
};

export default React.memo(ChatMessage);
