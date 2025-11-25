import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import MarkdownRenderer from './components/MarkdownRenderer.js';
import {useConversation} from './hooks/use-conversation.js';

export default function App() {
	const [input, setInput] = useState('');
	const {
		messages,
		liveResponse,
		waitingForApproval,
		isProcessing,
		getCommandFromArgs,
		sendUserMessage,
		handleApprovalDecision,
	} = useConversation();

	// Handle y/n key presses for approval prompts
	useInput(async inputKey => {
		if (!waitingForApproval || isProcessing) return;

		const answer = inputKey.toLowerCase();
		if (answer === 'y' || answer === 'n') {
			await handleApprovalDecision(answer);
		}
	});

	const handleSubmit = async value => {
		if (!value.trim()) return;
		// If waiting for approval, ignore text input (handled by useInput)
		if (waitingForApproval) return;

		setInput('');
		await sendUserMessage(value);
	};

	return (
		<Box flexDirection="column">
			<Box flexDirection="column" marginBottom={1}>
				{messages.map(msg => (
					<Box key={msg.id} marginBottom={msg.sender === 'approval' ? 1 : 0}>
						{msg.sender === 'approval' ? (
							<Box flexDirection="column">
								<Text color="yellow">
									{msg.interruption.agent.name} wants to run:{' '}
									<Text bold>{msg.interruption.name}</Text>
								</Text>
								<Text dimColor>
									{getCommandFromArgs(msg.interruption.arguments)}
								</Text>
								<Text>
									<Text color="yellow">(y/n)</Text>
									{msg.answer && (
										<Text color={msg.answer === 'y' ? 'green' : 'red'}>
											{' '}
											{msg.answer}
										</Text>
									)}
								</Text>
							</Box>
						) : msg.sender === 'command' ? (
							<Box flexDirection="column" marginBottom={1}>
								<Text color={msg.success === false ? 'red' : 'cyan'}>
									$ <Text bold>{msg.command}</Text>
								</Text>
								<Text color={msg.success === false ? 'red' : 'white'}>
									{msg.output?.trim()
										? (() => {
												const lines = msg.output.split('\n');
												return lines.length > 3
													? lines.slice(0, 3).join('\n') + '\n...'
													: msg.output;
										  })()
										: '(no output)'}
								</Text>
							</Box>
						) : (
							<Box marginBottom={1} flexDirection="column">
								{msg.sender === 'user' ? (
									<Text color="blue">❯ {msg.text}</Text>
								) : (
									<MarkdownRenderer>{msg.text}</MarkdownRenderer>
								)}
							</Box>
						)}
					</Box>
				))}
			</Box>

			{liveResponse && (
				<Box marginBottom={1} flexDirection="column">
					<MarkdownRenderer>{liveResponse.text || ' '}</MarkdownRenderer>
				</Box>
			)}

			{!isProcessing && !waitingForApproval && (
				<Box>
					<Text color="blue">❯ </Text>
					<TextInput
						value={input}
						onChange={setInput}
						onSubmit={handleSubmit}
					/>
				</Box>
			)}

			{isProcessing && (
				<Text color="gray" dimColor>
					⟳ processing...
				</Text>
			)}
		</Box>
	);
}
