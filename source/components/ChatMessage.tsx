import React, { FC } from 'react';
import { Box, Text } from 'ink';
import MarkdownRenderer from './MarkdownRenderer.js';

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
        <Text color="#64748b">{msg.text}</Text>
      ) : msg.sender === 'reasoning' ? (
        <MarkdownRenderer defaultColor="#64748b" maxWidth={maxWidth}>
          {msg.text}
        </MarkdownRenderer>
      ) : (
        <MarkdownRenderer maxWidth={maxWidth}>{msg.text}</MarkdownRenderer>
      )}
    </Box>
  );
};

export default React.memo(ChatMessage);
