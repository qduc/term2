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
				const marginBottom =
					msg.sender === 'approval'
						? 1
						: prev && prev.sender === msg.sender
						? 0
						: 1;

				return (
					<Box key={msg.id} marginBottom={marginBottom}>
						{msg.sender === 'approval' ? (
							<Box flexDirection="column">
								<ApprovalPrompt approval={msg.approval} />
								<Text>
									{msg.answer && (
										<Text color={msg.answer === 'y' ? 'green' : 'red'}>
											{' '}
											{msg.answer}
										</Text>
									)}
								</Text>
							</Box>
						) : msg.sender === 'command' ? (
							<CommandMessage
								command={msg.command}
								output={msg.output}
								success={msg.success}
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
