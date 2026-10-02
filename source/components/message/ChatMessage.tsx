import React, { FC } from 'react';
import { Box, Text } from 'ink';
import MarkdownRenderer from '../MarkdownRenderer.js';
import Divider from '../common/Divider.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
import type { Message } from '../../types/message.js';

type Props = {
  msg: Message;
  maxWidth?: number;
};

const ChatMessage: FC<Props> = ({ msg, maxWidth }) => {
  const theme = useTheme();
  const { UserMessage, AssistantFrame, assistantGutter } = useSkin();
  // The frame may consume columns on the left; markdown wraps against an explicit width.
  const answerWidth = maxWidth === undefined ? undefined : Math.max(1, maxWidth - assistantGutter);
  return (
    <Box flexDirection="column">
      {msg.sender === 'user' && msg.presentation === 'session_rollover' ? (
        <>
          <Text color={theme.reasoning}>↻ Session rollover briefing</Text>
          <MarkdownRenderer maxWidth={maxWidth}>{msg.text}</MarkdownRenderer>
        </>
      ) : msg.sender === 'user' ? (
        <UserMessage text={msg.text} />
      ) : msg.sender === 'system' && msg.presentation === 'rule' ? (
        <Divider width={maxWidth} />
      ) : msg.sender === 'system' && msg.memoryReceiptCount !== undefined ? (
        <Text color={theme.reasoning}>
          Loaded {msg.memoryReceiptCount} {msg.memoryReceiptCount === 1 ? 'memory' : 'memories'}
        </Text>
      ) : msg.sender === 'system' ? (
        <Text color={theme.reasoning}>{msg.text}</Text>
      ) : msg.sender === 'reasoning' ? (
        <AssistantFrame kind="reasoning">
          <MarkdownRenderer defaultColor={theme.reasoning} maxWidth={answerWidth}>
            {msg.text}
          </MarkdownRenderer>
        </AssistantFrame>
      ) : msg.sender === 'bot' ? (
        <AssistantFrame kind="answer">
          <MarkdownRenderer maxWidth={answerWidth}>{msg.text}</MarkdownRenderer>
        </AssistantFrame>
      ) : null}
    </Box>
  );
};

export default React.memo(ChatMessage);
