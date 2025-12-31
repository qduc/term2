import React, {FC} from 'react';
import { Box, Static } from 'ink';
import CommandMessage from './CommandMessage.js';
import ChatMessage from './ChatMessage.js';

type Props = {
    messages: any[];
};

const WINDOW_SIZE = 20;

const MessageList: FC<Props> = ({messages}) => {
    // Split messages into history (rendered once via Static) and active (rendered normally)
    const historyEndPoint = Math.max(0, messages.length - WINDOW_SIZE);

    // We only want to move "stable" messages to history.
    // However, for simplicity and performance, we assume messages outside the window
    // are stable enough or that the trade-off is worth it.
    // In a sliding window, the visual continuity is preserved.

    const history = messages.slice(0, historyEndPoint);
    const active = messages.slice(historyEndPoint);

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
            <Static items={history}>
                {(msg, idx) => renderMessage(msg, idx, history)}
            </Static>

            <Box flexDirection="column">
                {active.map((msg, idx) => renderMessage(msg, idx, active))}
            </Box>
        </Box>
    );
};

export default React.memo(MessageList);
