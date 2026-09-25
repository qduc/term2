import React, { FC } from 'react';
import { Box, Text } from 'ink';
import MarkdownRenderer from '../MarkdownRenderer.js';
import Divider from '../common/Divider.js';
import { COLOR_ACCENT, COLOR_REASONING, COLOR_USER_BACKGROUND } from '../theme.js';
import type { Message } from '../../types/message.js';

type Props = {
  msg: Message;
  maxWidth?: number;
};

const ChatMessage: FC<Props> = ({ msg, maxWidth }) => {
  return (
    <Box flexDirection="column">
      {msg.sender === 'user' && msg.presentation === 'session_rollover' ? (
        <>
          <Text color={COLOR_REASONING}>↻ Session rollover briefing</Text>
          <MarkdownRenderer maxWidth={maxWidth}>{msg.text}</MarkdownRenderer>
        </>
      ) : msg.sender === 'user' ? (
        <Box width="100%" backgroundColor={COLOR_USER_BACKGROUND} paddingX={1}>
          <Text bold>
            <Text color={COLOR_ACCENT}>❯ </Text>
            {msg.text}
          </Text>
        </Box>
      ) : msg.sender === 'system' && msg.presentation === 'rule' ? (
        <Divider width={maxWidth} />
      ) : msg.sender === 'system' && msg.memoryReceiptCount !== undefined ? (
        <Text color={COLOR_REASONING}>
          Loaded {msg.memoryReceiptCount} {msg.memoryReceiptCount === 1 ? 'memory' : 'memories'}
        </Text>
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
