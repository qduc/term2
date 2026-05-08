import React, { FC, useMemo } from 'react';
import { Box, Static } from 'ink';
import CommandMessage from './CommandMessage.js';
import ChatMessage from './ChatMessage.js';

type Props = {
  messages: any[];
};

const WINDOW_SIZE = 20;

type MessageLike = {
  sender?: string;
  status?: string;
};

const canRenderStatically = (message: MessageLike) => {
  if (message.sender === 'reasoning') {
    return false;
  }

  if (message.sender === 'command') {
    return message.status !== 'pending' && message.status !== 'running';
  }

  return true;
};

export const splitStaticHistory = <T extends MessageLike>(messages: T[], windowSize = WINDOW_SIZE) => {
  const activeStart = Math.max(0, messages.length - windowSize);
  const history: T[] = [];
  const active: T[] = [];

  messages.forEach((message, index) => {
    if (index >= activeStart || !canRenderStatically(message)) {
      active.push(message);
      return;
    }

    history.push(message);
  });

  return { history, active };
};

const MessageList: FC<Props> = ({ messages }) => {
  // Use useMemo to prevent array recreation on every render.
  // This stabilizes the references passed to Static and the active Box,
  // preventing unnecessary re-renders and fixing flickering in long sessions.
  const { history, active } = useMemo(() => {
    return splitStaticHistory(messages);
  }, [messages]);

  const renderMessage = (msg: any, idx: number, collection: any[]) => {
    // Use consistent marginTop to prevent layout reflow.
    // This ensures stable spacing regardless of message order or streaming updates.
    // The first message in each collection has no top margin to avoid extra space.
    const isFirst = idx === 0 && collection === active && history.length === 0;

    return (
      <Box key={msg.id} marginTop={isFirst ? 0 : 1}>
        {msg.sender === 'command' ? (
          <CommandMessage
            command={msg.command}
            output={msg.output}
            status={msg.status}
            success={msg.success}
            failureReason={msg.failureReason}
            toolName={msg.toolName}
            toolArgs={msg.toolArgs}
            isApprovalRejection={msg.isApprovalRejection}
            hadApproval={msg.hadApproval}
          />
        ) : (
          <ChatMessage msg={msg} />
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Static items={history}>{(msg, idx) => renderMessage(msg, idx, history)}</Static>

      <Box flexDirection="column">{active.map((msg, idx) => renderMessage(msg, idx, active))}</Box>
    </Box>
  );
};

export default React.memo(MessageList);
