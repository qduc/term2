import React, {FC} from 'react';
import {Box, Text} from 'ink';
import MarkdownRenderer from './MarkdownRenderer.js';

type Props = {
	msg: any;
};

const ChatMessage: FC<Props> = ({msg}) => {
	return (
		<Box flexDirection="column">
			{msg.sender === 'user' ? (
				<Text color="blue">❯ {msg.text}</Text>
			) : msg.sender === 'system' ? (
				<Text color="gray" dimColor>
					{msg.text}
				</Text>
			) : (
				<>
					{msg.reasoningText && (
						<Box marginBottom={1}>
							<Text color="gray" dimColor>
								{msg.reasoningText}
							</Text>
						</Box>
					)}
					<MarkdownRenderer>{msg.text}</MarkdownRenderer>
				</>
			)}
		</Box>
	);
};

export default ChatMessage;
