import React, {useState, useEffect} from 'react';
import {Box, Text, Newline} from 'ink';
import TextInput from 'ink-text-input';
import { run, RunState } from '@openai/agents';
import { agent, client } from './agent.js';

export default function App() {
	const [messages, setMessages] = useState([
		{id: 1, sender: 'bot', text: 'Hello! I am your terminal assistant. How can I help you?'},
	]);
	const [input, setInput] = useState('');
	const [waitingForApproval, setWaitingForApproval] = useState(false);
	const [currentRunResult, setCurrentRunResult] = useState(null);
	const [interruptionToApprove, setInterruptionToApprove] = useState(null);
	const [conversationId, setConversationId] = useState(null);

	const [isProcessing, setIsProcessing] = useState(false);

	useEffect(() => {
		// Create a server-managed conversation on component mount
		const initConversation = async () => {
			const { id } = await client.conversations.create({});
			setConversationId(id);
		};
		initConversation();
	}, []);

	const processRunResult = async (result) => {
		if (result.interruptions && result.interruptions.length > 0) {
			setWaitingForApproval(true);
			setCurrentRunResult(result);
			// For simplicity, we handle one interruption at a time
			setInterruptionToApprove(result.interruptions[0]);

			const interruption = result.interruptions[0];
			const approvalMsg = {
				id: Date.now(),
				sender: 'approval',
				interruption: interruption,
			};
			setMessages(prev => [...prev, approvalMsg]);
		} else {
			// Run completed
			const botMessage = {
				id: Date.now(),
				sender: 'bot',
				text: result.finalOutput || 'Done.',
			};
			setMessages(prev => [...prev, botMessage]);
			setWaitingForApproval(false);
			setCurrentRunResult(null);
			setInterruptionToApprove(null);
		}
	};

	const handleSubmit = async value => {
		if (!value.trim()) return;

		const userMessage = {
			id: Date.now(),
			sender: 'user',
			text: value,
		};
		setMessages(prev => [...prev, userMessage]);
		setInput('');
		setIsProcessing(true);

		if (waitingForApproval) {
			if (value.toLowerCase() === 'y') {
				// Approved
				currentRunResult.state.approve(interruptionToApprove);
				const nextResult = await run(agent, currentRunResult.state);
				await processRunResult(nextResult);
			} else {
				// Rejected
				currentRunResult.state.reject(interruptionToApprove);
				const nextResult = await run(agent, currentRunResult.state);
				await processRunResult(nextResult);
			}
		} else {
			// New run with server-managed conversation
			try {
				if (!conversationId) {
					throw new Error('Conversation not initialized yet');
				}
				const result = await run(agent, value, { conversationId });
				await processRunResult(result);
			} catch (error) {
				const errorMessage = {
					id: Date.now(),
					sender: 'bot',
					text: `Error: ${error.message}`,
				};
				setMessages(prev => [...prev, errorMessage]);
			}
		}
		setIsProcessing(false);
	};

	return (
		<Box flexDirection="column">
			<Box flexDirection="column" marginBottom={1}>
				{messages.map((msg, index) => (
					<Box key={msg.id} marginBottom={index < messages.length - 1 ? 1 : 0}>
						{msg.sender === 'approval' ? (
							<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
								<Box marginBottom={1}>
									<Text bold color="yellow">🔒 Permission Required</Text>
								</Box>
								<Box marginBottom={1}>
									<Text dimColor>Agent: </Text>
									<Text color="cyan">{msg.interruption.agent.name}</Text>
								</Box>
								<Box marginBottom={1}>
									<Text dimColor>Tool: </Text>
									<Text color="magenta">{msg.interruption.name}</Text>
								</Box>
								<Box flexDirection="column" marginBottom={1}>
									<Text dimColor>Arguments:</Text>
									<Box paddingLeft={2}>
										<Text color="white">{JSON.stringify(msg.interruption.arguments, null, 2)}</Text>
									</Box>
								</Box>
								<Box>
									<Text color="green">Approve? </Text>
									<Text dimColor>(y/Y to approve, any other key to reject)</Text>
								</Box>
							</Box>
						) : (
							<Box>
								<Text color={msg.sender === 'user' ? 'blue' : 'green'}>
									{msg.sender === 'user' ? 'You: ' : 'Bot: '}
								</Text>
								<Text>{msg.text}</Text>
							</Box>
						)}
					</Box>
				))}
			</Box>

			{!isProcessing && (
				<Box>
					<Text color="blue">You: </Text>
					<TextInput
						value={input}
						onChange={setInput}
						onSubmit={handleSubmit}
					/>
				</Box>
			)}
		</Box>
	);
}
