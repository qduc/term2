import React, {FC} from 'react';
import {Box, Text} from 'ink';
import ApprovalPrompt from './ApprovalPrompt.js';
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
                    msg.sender === 'approval'
                        ? 1
                        : prev && prev.sender === msg.sender
                        ? 0
                        : 1;

                // Check if this command message was preceded by an approval
                const hadApproval =
                    msg.sender === 'command' &&
                    msg.toolName === 'search_replace' &&
                    prev?.sender === 'approval' &&
                    prev?.approval?.toolName === 'search_replace' &&
                    prev?.answer === 'y';

                return (
                    <Box key={msg.id} marginTop={marginTop}>
                        {msg.sender === 'approval' ? (
                            <Box flexDirection="column">
                                <ApprovalPrompt approval={msg.approval} />
                                <Text>
                                    {msg.answer && (
                                        <Text
                                            color={
                                                msg.answer === 'y'
                                                    ? 'green'
                                                    : 'red'
                                            }
                                        >
                                            {' '}
                                            {msg.answer}
                                        </Text>
                                    )}
                                    {msg.answer === 'n' && msg.rejectionReason && (
                                        <Text color="gray" dimColor>
                                            {' - '}
                                            {msg.rejectionReason}
                                        </Text>
                                    )}
                                </Text>
                            </Box>
                        ) : msg.sender === 'command' ? (
                            <CommandMessage
                                command={msg.command}
                                output={msg.output}
                                success={msg.success}
                                failureReason={msg.failureReason}
                                toolName={msg.toolName}
                                toolArgs={msg.toolArgs}
                                isApprovalRejection={msg.isApprovalRejection}
                                hadApproval={hadApproval}
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
