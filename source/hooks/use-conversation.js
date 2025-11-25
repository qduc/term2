import {useCallback, useState} from 'react';
import {defaultConversationService} from '../services/conversation-service.js';

const INITIAL_BOT_MESSAGE = {
	id: 1,
	sender: 'bot',
	text: 'Hello! I am your terminal assistant. How can I help you?',
};

export const useConversation = ({
	conversationService = defaultConversationService,
} = {}) => {
	const [messages, setMessages] = useState([INITIAL_BOT_MESSAGE]);
	const [waitingForApproval, setWaitingForApproval] = useState(false);
	const [pendingApprovalMessageId, setPendingApprovalMessageId] = useState(null);
	const [isProcessing, setIsProcessing] = useState(false);
	const [liveResponse, setLiveResponse] = useState(null);

	const applyServiceResult = useCallback(result => {
		if (!result) {
			return;
		}

		if (result.type === 'approval_required') {
			const approvalMessage = {
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

		const botMessage = {
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
		async value => {
			if (!value.trim()) {
				return;
			}

			const userMessage = {id: Date.now(), sender: 'user', text: value};
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
				setMessages(prev => [
					...prev,
					{id: Date.now(), sender: 'bot', text: `Error: ${error.message}`},
				]);
			} finally {
				setLiveResponse(null);
				setIsProcessing(false);
			}
		},
		[conversationService, applyServiceResult],
	);

	const handleApprovalDecision = useCallback(
		async answer => {
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
				setMessages(prev => [
					...prev,
					{id: Date.now(), sender: 'bot', text: `Error: ${error.message}`},
				]);
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

	return {
		messages,
		liveResponse,
		waitingForApproval,
		isProcessing,
		sendUserMessage,
		handleApprovalDecision,
	};
};
