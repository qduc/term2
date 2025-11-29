import {useCallback, useState} from 'react';
import type {ConversationService} from '../services/conversation-service.js';

interface UserMessage {
	id: number;
	sender: 'user';
	text: string;
}

interface BotMessage {
	id: number;
	sender: 'bot';
	text: string;
	reasoningText?: string;
}

interface ApprovalMessage {
	id: number;
	sender: 'approval';
	approval: {
		agentName: string;
		toolName: string;
		argumentsText: string;
		rawInterruption: any;
	};
	answer: string | null;
}

interface CommandMessage {
	id: string;
	sender: 'command';
	command: string;
	output: string;
	success?: boolean;
}

interface SystemMessage {
	id: number;
	sender: 'system';
	text: string;
}

interface ReasoningMessage {
	id: number;
	sender: 'reasoning';
	text: string;
}

type Message =
	| UserMessage
	| BotMessage
	| ApprovalMessage
	| CommandMessage
	| SystemMessage
	| ReasoningMessage;

interface LiveResponse {
	id: number;
	sender: 'bot';
	text: string;
	reasoningText: string;
}

export const useConversation = ({
	conversationService,
}: {
	conversationService: ConversationService;
}) => {
	const [messages, setMessages] = useState<Message[]>([]);
	const [waitingForApproval, setWaitingForApproval] =
		useState<boolean>(false);
	const [pendingApprovalMessageId, setPendingApprovalMessageId] = useState<
		number | null
	>(null);
	const [isProcessing, setIsProcessing] = useState<boolean>(false);
	const [liveResponse, setLiveResponse] = useState<LiveResponse | null>(null);

	const applyServiceResult = useCallback(
		(
			result: any,
			remainingText?: string,
			remainingReasoningText?: string,
			textWasFlushed?: boolean,
		) => {
			if (!result) {
				return;
			}

			if (result.type === 'approval_required') {
				// Flush reasoning and text separately before showing approval prompt
				const messagesToAdd: Message[] = [];

				if (remainingReasoningText?.trim() && !textWasFlushed) {
					const reasoningMessage: ReasoningMessage = {
						id: Date.now(),
						sender: 'reasoning',
						text: remainingReasoningText,
					};
					messagesToAdd.push(reasoningMessage);
				}

				if (remainingText?.trim() && !textWasFlushed) {
					const textMessage: BotMessage = {
						id: Date.now() + 1,
						sender: 'bot',
						text: remainingText,
					};
					messagesToAdd.push(textMessage);
				}

				const approvalMessage: ApprovalMessage = {
					id: Date.now() + 2,
					sender: 'approval',
					approval: result.approval,
					answer: null,
				};

				setMessages(prev => [
					...prev,
					...messagesToAdd,
					approvalMessage,
				]);
				setWaitingForApproval(true);
				setPendingApprovalMessageId(approvalMessage.id);
				return;
			}

			// If text was already flushed before command messages, don't add it again
			// Only add final text if there's new text after the commands
			const shouldAddBotMessage =
				!textWasFlushed || remainingText?.trim();
			const finalText = remainingText?.trim()
				? remainingText
				: result.finalText;
			// Only use result.reasoningText if nothing was flushed yet
			// When textWasFlushed is true, reasoning was already flushed before commands
			const finalReasoningText = textWasFlushed
				? remainingReasoningText
				: remainingReasoningText || result.reasoningText;

			setMessages(prev => {
				const messagesToAdd: Message[] = [];

				// Add reasoning as a separate message if it exists and wasn't flushed
				if (finalReasoningText?.trim()) {
					const reasoningMessage: ReasoningMessage = {
						id: Date.now(),
						sender: 'reasoning',
						text: finalReasoningText,
					};
					messagesToAdd.push(reasoningMessage);
				}

				const withCommands =
					result.commandMessages.length > 0
						? [...prev, ...messagesToAdd, ...result.commandMessages]
						: [...prev, ...messagesToAdd];

				if (shouldAddBotMessage && finalText) {
					const botMessage: BotMessage = {
						id: Date.now() + 1,
						sender: 'bot',
						text: finalText,
					};
					return [...withCommands, botMessage];
				}

				return withCommands;
			});
			setWaitingForApproval(false);
			setPendingApprovalMessageId(null);
		},
		[],
	);

	const sendUserMessage = useCallback(
		async (value: string) => {
			if (!value.trim()) {
				return;
			}

			const userMessage: UserMessage = {
				id: Date.now(),
				sender: 'user',
				text: value,
			};
			setMessages(prev => [...prev, userMessage]);
			setIsProcessing(true);

			const liveMessageId = Date.now();
			setLiveResponse({
				id: liveMessageId,
				sender: 'bot',
				text: '',
				reasoningText: '',
			});

			// Track accumulated text so we can flush it before command messages
			let accumulatedText = '';
			let accumulatedReasoningText = '';
			let flushedReasoningLength = 0; // Track how much reasoning has been flushed
			let textWasFlushed = false;

			try {
				const result = await conversationService.sendMessage(value, {
					onTextChunk: (fullText, chunk = '') => {
						accumulatedText += chunk;
						setLiveResponse(prev =>
							prev && prev.id === liveMessageId
								? {...prev, text: fullText}
								: prev,
						);
					},
					onReasoningChunk: fullReasoningText => {
						// Only show reasoning text after what was already flushed
						const newReasoningText =
							fullReasoningText.slice(flushedReasoningLength);
						accumulatedReasoningText = newReasoningText;
						setLiveResponse(prev =>
							prev && prev.id === liveMessageId
								? {...prev, reasoningText: newReasoningText}
								: prev,
						);
					},
					onCommandMessage: cmdMsg => {
						// Before adding command message, flush reasoning and text separately
						// This preserves the order: reasoning -> command -> response text
						const messagesToAdd: Message[] = [];

						if (accumulatedReasoningText.trim()) {
							const reasoningMessage: ReasoningMessage = {
								id: Date.now(),
								sender: 'reasoning',
								text: accumulatedReasoningText,
							};
							messagesToAdd.push(reasoningMessage);
							// Track how much reasoning we've flushed so we don't show it again
							flushedReasoningLength += accumulatedReasoningText.length;
							accumulatedReasoningText = '';
						}

						if (accumulatedText.trim()) {
							const textMessage: BotMessage = {
								id: Date.now() + 1,
								sender: 'bot',
								text: accumulatedText,
							};
							messagesToAdd.push(textMessage);
							accumulatedText = '';
							textWasFlushed = true;
						}

						if (messagesToAdd.length > 0) {
							setMessages(prev => [...prev, ...messagesToAdd]);
							// Clear live response since we've committed the text
							setLiveResponse(null);
						}

						// Add command messages in real-time as they execute
						setMessages(prev => [...prev, cmdMsg]);
					},
				});

				applyServiceResult(
					result,
					accumulatedText,
					accumulatedReasoningText,
					textWasFlushed,
				);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				const botErrorMessage: BotMessage = {
					id: Date.now(),
					sender: 'bot',
					text: `Error: ${errorMessage}`,
				};
				setMessages(prev => [...prev, botErrorMessage]);
			} finally {
				setLiveResponse(null);
				setIsProcessing(false);
			}
		},
		[conversationService, applyServiceResult],
	);

	const handleApprovalDecision = useCallback(
		async (answer: string) => {
			if (!waitingForApproval) {
				return;
			}

			setMessages(prev =>
				prev.map(msg =>
					msg.sender === 'approval' &&
					msg.id === pendingApprovalMessageId
						? {...msg, answer}
						: msg,
				),
			);

			setIsProcessing(true);
			const liveMessageId = Date.now();
			setLiveResponse({
				id: liveMessageId,
				sender: 'bot',
				text: '',
				reasoningText: '',
			});

			// Track accumulated text so we can flush it before command messages
			let accumulatedText = '';
			let accumulatedReasoningText = '';
			let flushedReasoningLength = 0; // Track how much reasoning has been flushed
			let textWasFlushed = false;

			try {
				const result = await conversationService.handleApprovalDecision(
					answer,
					{
						onTextChunk: (fullText, chunk = '') => {
							accumulatedText += chunk;
							setLiveResponse(prev =>
								prev && prev.id === liveMessageId
									? {...prev, text: fullText}
									: prev,
							);
						},
						onReasoningChunk: fullReasoningText => {
							// Only show reasoning text after what was already flushed
							const newReasoningText =
								fullReasoningText.slice(flushedReasoningLength);
							accumulatedReasoningText = newReasoningText;
							setLiveResponse(prev =>
								prev && prev.id === liveMessageId
									? {
											...prev,
											reasoningText: newReasoningText,
									  }
									: prev,
							);
						},
						onCommandMessage: cmdMsg => {
							// Before adding command message, flush reasoning and text separately
							// This preserves the order: reasoning -> command -> response text
							const messagesToAdd: Message[] = [];

							if (accumulatedReasoningText.trim()) {
								const reasoningMessage: ReasoningMessage = {
									id: Date.now(),
									sender: 'reasoning',
									text: accumulatedReasoningText,
								};
								messagesToAdd.push(reasoningMessage);
								// Track how much reasoning we've flushed so we don't show it again
								flushedReasoningLength +=
									accumulatedReasoningText.length;
								accumulatedReasoningText = '';
							}

							if (accumulatedText.trim()) {
								const textMessage: BotMessage = {
									id: Date.now() + 1,
									sender: 'bot',
									text: accumulatedText,
								};
								messagesToAdd.push(textMessage);
								accumulatedText = '';
								textWasFlushed = true;
							}

							if (messagesToAdd.length > 0) {
								setMessages(prev => [
									...prev,
									...messagesToAdd,
								]);
								// Clear live response since we've committed the text
								setLiveResponse(null);
							}

							// Add command messages in real-time as they execute
							setMessages(prev => [...prev, cmdMsg]);
						},
					},
				);
				applyServiceResult(
					result,
					accumulatedText,
					accumulatedReasoningText,
					textWasFlushed,
				);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				const botErrorMessage: BotMessage = {
					id: Date.now(),
					sender: 'bot',
					text: `Error: ${errorMessage}`,
				};
				setMessages(prev => [...prev, botErrorMessage]);
			} finally {
				setLiveResponse(null);
				setIsProcessing(false);
			}
		},
		[
			applyServiceResult,
			conversationService,
			pendingApprovalMessageId,
			waitingForApproval,
		],
	);

	const clearConversation = useCallback(() => {
		conversationService.reset();
		setMessages([]);
		setWaitingForApproval(false);
		setPendingApprovalMessageId(null);
		setIsProcessing(false);
		setLiveResponse(null);
	}, [conversationService]);

	const stopProcessing = useCallback(() => {
		conversationService.abort();
		setWaitingForApproval(false);
		setPendingApprovalMessageId(null);
		setIsProcessing(false);
		setLiveResponse(null);
	}, [conversationService]);

	const setModel = useCallback(
		(model: string) => {
			conversationService.setModel(model);
		},
		[conversationService],
	);

	const addSystemMessage = useCallback((text: string) => {
		setMessages(prev => [
			...prev,
			{
				id: Date.now(),
				sender: 'system',
				text,
			},
		]);
	}, []);

	return {
		messages,
		liveResponse,
		waitingForApproval,
		isProcessing,
		sendUserMessage,
		handleApprovalDecision,
		clearConversation,
		stopProcessing,
		setModel,
		addSystemMessage,
	};
};
