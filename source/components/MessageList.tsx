import React, { FC, useMemo } from 'react';
import { Box, Static } from 'ink';
import CommandMessage from './CommandMessage.js';
import ChatMessage from './ChatMessage.js';

type Props = {
  messages: any[];
};

const WINDOW_SIZE = 20;

const MessageList: FC<Props> = ({ messages }) => {
  // Split messages into history (rendered once via Static) and active (rendered normally)
  const historyEndPoint = Math.max(0, messages.length - WINDOW_SIZE);

  // Use useMemo to prevent array recreation on every render.
  // This stabilizes the references passed to Static and the active Box,
  // preventing unnecessary re-renders and fixing flickering in long sessions.
  const { history, active } = useMemo(() => {
    const hist = messages.slice(0, historyEndPoint);
    const act = messages.slice(historyEndPoint);
    return { history: hist, active: act };
  }, [messages, historyEndPoint]);

  const renderMessage = (msg: any, idx: number, collection: any[]) => {
    // Use consistent marginBottom instead of dynamic marginTop to prevent layout reflow.
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
