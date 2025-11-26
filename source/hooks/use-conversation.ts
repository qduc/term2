import {useCallback, useState} from 'react';
import type {ConversationService} from '../services/conversation-service.js';
import {defaultConversationService} from '../services/conversation-service.js';

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

type Message = UserMessage | BotMessage | ApprovalMessage | CommandMessage;

interface LiveResponse {
	id: number;
	sender: 'bot';
	text: string;
}

export const useConversation = ({
	conversationService = defaultConversationService,
}: {conversationService?: ConversationService} = {}) => {
	const [messages, setMessages] = useState<Message[]>([]);
	const [waitingForApproval, setWaitingForApproval] = useState<boolean>(false);
	const [pendingApprovalMessageId, setPendingApprovalMessageId] = useState<
		number | null
	>(null);
	const [isProcessing, setIsProcessing] = useState<boolean>(false);
	const [liveResponse, setLiveResponse] = useState<LiveResponse | null>(null);

	const applyServiceResult = useCallback((result: any) => {
		if (!result) {
			return;
		}

		if (result.type === 'approval_required') {
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

		const botMessage: BotMessage = {
			id: Date.now(),
			sender: 'bot',
			text: result.finalText,
		};

		setMessages(prev => {
			const withCommands =
				result.commandMessages.length > 0
					? [...prev, ...result.commandMessages]
					: prev;
			return [...withCommands, botMessage];
		});
		setWaitingForApproval(false);
		setPendingApprovalMessageId(null);
	}, []);

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
			setLiveResponse({id: liveMessageId, sender: 'bot', text: ''});

			try {
				const result = await conversationService.sendMessage(value, {
					onTextChunk: text => {
						setLiveResponse(prev =>
							prev && prev.id === liveMessageId ? {...prev, text} : prev,
						);
					},
				});

				applyServiceResult(result);
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
					msg.sender === 'approval' && msg.id === pendingApprovalMessageId
						? {...msg, answer}
						: msg,
				),
			);

			setIsProcessing(true);
			try {
				const result = await conversationService.handleApprovalDecision(answer);
				applyServiceResult(result);
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
		setMessages([INITIAL_BOT_MESSAGE]);
		setWaitingForApproval(false);
		setPendingApprovalMessageId(null);
		setIsProcessing(false);
		setLiveResponse(null);
	}, [conversationService]);

	return {
		messages,
		liveResponse,
		waitingForApproval,
		isProcessing,
		sendUserMessage,
		handleApprovalDecision,
		clearConversation,
	};
};
