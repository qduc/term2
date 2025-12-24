import React, {FC} from 'react';
import {Box} from 'ink';
import CommandMessage from './CommandMessage.js';
import ChatMessage from './ChatMessage.js';

type Props = {
    messages: any[];
};

const MessageList: FC<Props> = ({messages}) => {
    return (
        <Box flexDirection="column">
            {messages.map((msg, idx) => {
                const prev = messages[idx - 1];
                // Tighten spacing between messages from the same sender (no extra gap),
                // but keep a small gap when the sender changes so different participants
                // remain recognizable.
                const marginTop =
                    prev && prev.sender === msg.sender
                        ? 0
                        : 1;

                return (
                    <Box key={msg.id} marginTop={marginTop}>
                        {msg.sender === 'command' ? (
                            <CommandMessage
                                command={msg.command}
                                output={msg.output}
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
            })}
        </Box>
    );
};

export default MessageList;
