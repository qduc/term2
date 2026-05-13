import React, { FC } from 'react';
import { Box, Text } from 'ink';
import MarkdownRenderer from './MarkdownRenderer.js';

type Props = {
  msg: any;
};

const ChatMessage: FC<Props> = ({ msg }) => {
  return (
    <Box flexDirection="column">
      {msg.sender === 'user' ? (
        <Text color="#22d3ee">❯ {msg.text}</Text>
      ) : msg.sender === 'system' ? (
        <Text color="#64748b">{msg.text}</Text>
      ) : msg.sender === 'reasoning' ? (
        <MarkdownRenderer defaultColor="#64748b" dimColor>
          {msg.text}
        </MarkdownRenderer>
      ) : (
        <MarkdownRenderer>{msg.text}</MarkdownRenderer>
      )}
    </Box>
  );
};

export default React.memo(ChatMessage);
