import React, {FC, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {useConversation} from './hooks/use-conversation.js';
import MessageList from './components/MessageList.js';
import InputBox from './components/InputBox.js';
import LiveResponse from './components/LiveResponse.js';

const App: FC = () => {
	const [input, setInput] = useState<string>('');
	const {
		messages,
		liveResponse,
		waitingForApproval,
		isProcessing,
		sendUserMessage,
		handleApprovalDecision,
	} = useConversation();

	// Handle y/n key presses for approval prompts
	useInput(async (inputKey: string) => {
		if (!waitingForApproval || isProcessing) return;

		const answer = inputKey.toLowerCase();
		if (answer === 'y' || answer === 'n') {
			await handleApprovalDecision(answer);
		}
	});

	const handleSubmit = async (value: string): Promise<void> => {
		if (!value.trim()) return;
		// If waiting for approval, ignore text input (handled by useInput)
		if (waitingForApproval) return;

		setInput('');
		await sendUserMessage(value);
	};

	return (
		<Box flexDirection="column">
			<MessageList messages={messages} />

			{liveResponse && <LiveResponse text={liveResponse.text} />}

			{!isProcessing && !waitingForApproval && (
				<InputBox value={input} onChange={setInput} onSubmit={handleSubmit} />
			)}

			{isProcessing && (
				<Text color="gray" dimColor>
					⟳ processing...
				</Text>
			)}
		</Box>
	);
};

export default App;
