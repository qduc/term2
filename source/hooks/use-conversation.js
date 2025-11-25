import {useCallback, useState} from 'react';
import {defaultAgentClient} from '../lib/openai-agent-client.js';
import {extractCommandMessages} from '../utils/extract-command-messages.js';

const getCommandFromArgs = args => {
	if (!args) {
		return '';
	}

	if (typeof args === 'string') {
		try {
			const parsed = JSON.parse(args);
			return parsed?.command ?? args;
		} catch {
			return args;
		}
	}

	if (typeof args === 'object') {
		return args.command ?? args.arguments ?? JSON.stringify(args);
	}

	return String(args);
};

const INITIAL_BOT_MESSAGE = {
	id: 1,
	sender: 'bot',
	text: 'Hello! I am your terminal assistant. How can I help you?',
};

export const useConversation = ({agentClient = defaultAgentClient} = {}) => {
	const [messages, setMessages] = useState([INITIAL_BOT_MESSAGE]);
	const [waitingForApproval, setWaitingForApproval] = useState(false);
	const [currentRunResult, setCurrentRunResult] = useState(null);
	const [interruptionToApprove, setInterruptionToApprove] = useState(null);
	const [previousResponseId, setPreviousResponseId] = useState(null);
	const [isProcessing, setIsProcessing] = useState(false);
	const [liveResponse, setLiveResponse] = useState(null);

	const processRunResult = useCallback(
		async (result, finalOutputOverride) => {
			if (result.interruptions && result.interruptions.length > 0) {
				const interruption = result.interruptions[0];
				setWaitingForApproval(true);
				setCurrentRunResult(result);
				setInterruptionToApprove(interruption);

				const approvalMsg = {
					id: Date.now(),
					sender: 'approval',
					interruption,
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
		},
		[],
	);

	const sendUserMessage = useCallback(
		async value => {
			if (!value.trim()) {
				return;
			}

			const userMessage = {id: Date.now(), sender: 'user', text: value};
			setMessages(prev => [...prev, userMessage]);
			setIsProcessing(true);

			try {
				const stream = await agentClient.startStream(value, {previousResponseId});
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
				setIsProcessing(false);
			}
		},
		[agentClient, previousResponseId, processRunResult],
	);

	const handleApprovalDecision = useCallback(
		async answer => {
			if (!currentRunResult || !interruptionToApprove) {
				return;
			}

			setMessages(prev =>
				prev.map(msg =>
					msg.sender === 'approval' &&
					msg.interruption === interruptionToApprove
						? {...msg, answer}
						: msg,
				),
			);

			setIsProcessing(true);
			if (answer === 'y') {
				currentRunResult.state.approve(interruptionToApprove);
			} else {
				currentRunResult.state.reject(interruptionToApprove);
			}

			const nextResult = await agentClient.continueRun(currentRunResult.state);
			await processRunResult(nextResult);
			setIsProcessing(false);
		},
		[
			agentClient,
			currentRunResult,
			interruptionToApprove,
			processRunResult,
		],
	);

	return {
		messages,
		liveResponse,
		waitingForApproval,
		isProcessing,
		interruptionToApprove,
		sendUserMessage,
		handleApprovalDecision,
		getCommandFromArgs,
	};
};
