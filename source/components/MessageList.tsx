import React, { FC, useMemo } from 'react';
import { Box, Static } from 'ink';
import CommandMessage from './CommandMessage.js';
import ChatMessage from './ChatMessage.js';

type Props = {
  messages: any[];
};

type MessageLike = {
  sender?: string;
  status?: string;
};

const canRenderStatically = (message: MessageLike) => {
  if (message.sender === 'reasoning') {
    return message.status === 'finalized';
  }

  if (message.sender === 'command') {
    return message.status !== 'pending' && message.status !== 'running';
  }

  return true;
};

export const splitStaticHistory = <T extends MessageLike>(messages: T[]) => {
  const activeStart = messages.findIndex((message) => !canRenderStatically(message));
  if (activeStart === -1) {
    return { history: messages, active: [] };
  }

  return {
    history: messages.slice(0, activeStart),
    active: messages.slice(activeStart),
  };
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
