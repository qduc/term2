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

type Message =
	| UserMessage
	| BotMessage
	| ApprovalMessage
	| CommandMessage
	| SystemMessage;

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
		(result: any, remainingText?: string, textWasFlushed?: boolean) => {
			if (!result) {
				return;
			}

			if (result.type === 'approval_required') {
				// Flush any remaining text before showing approval prompt
				if (remainingText?.trim() && !textWasFlushed) {
					const textMessage: BotMessage = {
						id: Date.now(),
						sender: 'bot',
						text: remainingText,
					};
					setMessages(prev => [...prev, textMessage]);
				}

				const approvalMessage: ApprovalMessage = {
					id: Date.now(),
					sender: 'approval',
					approval: result.approval,
					answer: null,
				};

				setMessages(prev => [...prev, approvalMessage]);
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

			setMessages(prev => {
				const withCommands =
					result.commandMessages.length > 0
						? [...prev, ...result.commandMessages]
						: prev;

				if (shouldAddBotMessage && finalText) {
					const botMessage: BotMessage = {
						id: Date.now(),
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
						setLiveResponse(prev =>
							prev && prev.id === liveMessageId
								? {...prev, reasoningText: fullReasoningText}
								: prev,
						);
					},
					onCommandMessage: cmdMsg => {
						// Before adding command message, flush any accumulated text as a bot message
						// This preserves the order: text before tool calls appears before command output
						if (accumulatedText.trim()) {
							const textMessage: BotMessage = {
								id: Date.now(),
								sender: 'bot',
								text: accumulatedText,
							};
							setMessages(prev => [...prev, textMessage]);
							accumulatedText = '';
							textWasFlushed = true;
							// Clear live response since we've committed the text
							setLiveResponse(null);
						}

						// Add command messages in real-time as they execute
						setMessages(prev => [...prev, cmdMsg]);
					},
				});

				applyServiceResult(result, accumulatedText, textWasFlushed);
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
							setLiveResponse(prev =>
								prev && prev.id === liveMessageId
									? {
											...prev,
											reasoningText: fullReasoningText,
									  }
									: prev,
							);
						},
						onCommandMessage: cmdMsg => {
							// Before adding command message, flush any accumulated text as a bot message
							// This preserves the order: text before tool calls appears before command output
							if (accumulatedText.trim()) {
								const textMessage: BotMessage = {
									id: Date.now(),
									sender: 'bot',
									text: accumulatedText,
								};
								setMessages(prev => [...prev, textMessage]);
								accumulatedText = '';
								textWasFlushed = true;
								// Clear live response since we've committed the text
								setLiveResponse(null);
							}

							// Add command messages in real-time as they execute
							setMessages(prev => [...prev, cmdMsg]);
						},
					},
				);
				applyServiceResult(result, accumulatedText, textWasFlushed);
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
		setModel,
		addSystemMessage,
	};
};
