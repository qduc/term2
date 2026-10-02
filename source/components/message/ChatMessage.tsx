import React, { FC } from 'react';
import { Box, Text } from 'ink';
import MarkdownRenderer from '../MarkdownRenderer.js';
import Divider from '../common/Divider.js';
import { useTheme } from '../theme.js';
import type { Message } from '../../types/message.js';

type Props = {
  msg: Message;
  maxWidth?: number;
};

const ChatMessage: FC<Props> = ({ msg, maxWidth }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {msg.sender === 'user' && msg.presentation === 'session_rollover' ? (
        <>
          <Text color={theme.reasoning}>↻ Session rollover briefing</Text>
          <MarkdownRenderer maxWidth={maxWidth}>{msg.text}</MarkdownRenderer>
        </>
      ) : msg.sender === 'user' ? (
        <Box width="100%" backgroundColor={theme.userBackground} paddingX={1}>
          <Text bold color={theme.userText}>
            <Text color={theme.accent}>❯ </Text>
            {msg.text}
          </Text>
        </Box>
      ) : msg.sender === 'system' && msg.presentation === 'rule' ? (
        <Divider width={maxWidth} />
      ) : msg.sender === 'system' && msg.memoryReceiptCount !== undefined ? (
        <Text color={theme.reasoning}>
          Loaded {msg.memoryReceiptCount} {msg.memoryReceiptCount === 1 ? 'memory' : 'memories'}
        </Text>
      ) : msg.sender === 'system' ? (
        <Text color={theme.reasoning}>{msg.text}</Text>
      ) : msg.sender === 'reasoning' ? (
        <MarkdownRenderer defaultColor={theme.reasoning} maxWidth={maxWidth}>
          {msg.text}
        </MarkdownRenderer>
      ) : msg.sender === 'bot' ? (
        <MarkdownRenderer maxWidth={maxWidth}>{msg.text}</MarkdownRenderer>
      ) : null}
    </Box>
  );
};

export default React.memo(ChatMessage);
