import React, {useState} from 'react';
import {Box, Text} from 'ink';
import TextInput from 'ink-text-input';
import MarkdownRenderer from './components/MarkdownRenderer.js';
import {run} from '@openai/agents';
import {agent} from './agent.js';
import {extractCommandMessages} from './utils/extract-command-messages.js';

export default function App() {
	const [messages, setMessages] = useState([
		{
			id: 1,
			sender: 'bot',
			text: 'Hello! I am your terminal assistant. How can I help you?',
		},
	]);
	const [input, setInput] = useState('');
	const [waitingForApproval, setWaitingForApproval] = useState(false);
	const [currentRunResult, setCurrentRunResult] = useState(null);
	const [interruptionToApprove, setInterruptionToApprove] = useState(null);
	const [previousResponseId, setPreviousResponseId] = useState(null);
	const [isProcessing, setIsProcessing] = useState(false);
	const [liveResponse, setLiveResponse] = useState(null);

	const processRunResult = async (result, finalOutputOverride) => {
		if (result.interruptions && result.interruptions.length > 0) {
			setWaitingForApproval(true);
			setCurrentRunResult(result);
			setInterruptionToApprove(result.interruptions[0]);

			const approvalMsg = {
				id: Date.now(),
				sender: 'approval',
				interruption: result.interruptions[0],
			};
			setMessages(prev => [...prev, approvalMsg]);
		} else {
			const commandMessages = extractCommandMessages(
				result.newItems || result.history || [],
			);
			const botMessage = {
				id: Date.now(),
				sender: 'bot',
				text: finalOutputOverride ?? result.finalOutput ?? 'Done.',
			};
			setMessages(prev => {
				const withCommands =
					commandMessages.length > 0 ? [...prev, ...commandMessages] : prev;
				return [...withCommands, botMessage];
			});
			setWaitingForApproval(false);
			setCurrentRunResult(null);
			setInterruptionToApprove(null);
		}
	};

	const handleSubmit = async value => {
		if (!value.trim()) return;
		const userMessage = {id: Date.now(), sender: 'user', text: value};
		setMessages(prev => [...prev, userMessage]);
		setInput('');
		setIsProcessing(true);

		if (waitingForApproval) {
			if (value.toLowerCase() === 'y') {
				currentRunResult.state.approve(interruptionToApprove);
				const nextResult = await run(agent, currentRunResult.state);
				await processRunResult(nextResult);
			} else {
				currentRunResult.state.reject(interruptionToApprove);
				const nextResult = await run(agent, currentRunResult.state);
				await processRunResult(nextResult);
			}
		} else {
			try {
				const stream = await run(agent, value, {
					previousResponseId,
					stream: true,
				});

				const liveMessageId = Date.now();
				setLiveResponse({id: liveMessageId, sender: 'bot', text: ''});

				const updateLiveText = text => {
					setLiveResponse(prev =>
						prev && prev.id === liveMessageId ? {...prev, text} : prev,
					);
				};

				let finalOutput = '';
				const textStream = stream.toTextStream();
				for await (const chunk of textStream) {
					finalOutput += chunk;
					updateLiveText(finalOutput);
				}

				await stream.completed;
				setPreviousResponseId(stream.lastResponseId);
				await processRunResult(stream, finalOutput || undefined);
			} catch (error) {
				setMessages(prev => [
					...prev,
					{id: Date.now(), sender: 'bot', text: `Error: ${error.message}`},
				]);
			} finally {
				setLiveResponse(null);
			}
		}

		setIsProcessing(false);
	};

	return (
		<Box flexDirection="column">
			<Box flexDirection="column" marginBottom={1}>
				{messages.map(msg => (
					<Box key={msg.id} marginBottom={msg.sender === 'approval' ? 1 : 0}>
						{msg.sender === 'approval' ? (
							<Box flexDirection="column">
								<Text color="yellow">
									🔒 {msg.interruption.agent.name} wants to run:{' '}
									<Text bold>{msg.interruption.name}</Text>
								</Text>
								<Text dimColor>
									$ {JSON.stringify(msg.interruption.arguments)}{' '}
									<Text color="yellow">(y/n)</Text>
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
					<Text color="gray" dimColor>
						…streaming
					</Text>
				</Box>
			)}

			{!isProcessing && (
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
