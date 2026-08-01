import React, { FC } from 'react';
import { Box, Text } from 'ink';
import MarkdownRenderer from '../MarkdownRenderer.js';
import { COLOR_REASONING } from '../theme.js';
import type { Message } from '../../types/message.js';

type Props = {
  msg: Message;
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
      ) : msg.sender === 'bot' ? (
        <MarkdownRenderer maxWidth={maxWidth}>{msg.text}</MarkdownRenderer>
      ) : null}
    </Box>
  );
};

export default React.memo(ChatMessage);
