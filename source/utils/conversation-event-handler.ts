/**
 * Factory for creating conversation event handlers.
 * Extracted from use-conversation.ts to enable testing.
 */

import type {ConversationEvent} from '../services/conversation-events.js';
import {
	parseToolArguments,
	formatToolCommand,
	type StreamingState,
} from './conversation-utils.js';

/**
 * Message types used by the event handler.
 */
export interface BotMessage {
	id: number;
	sender: 'bot';
	text: string;
}

export interface CommandMessage {
	id: string;
	sender: 'command';
	status: 'pending' | 'running' | 'completed' | 'failed';
	command: string;
	output: string;
	success?: boolean;
	failureReason?: string;
	isApprovalRejection?: boolean;
	callId?: string;
	toolName?: string;
	toolArgs?: unknown;
}

export interface SystemMessage {
	id: number;
	sender: 'system';
	text: string;
}

/**
 * Dependencies injected into the event handler factory.
 * Uses `any` for React setState compatibility - internal utility.
 */
export interface ConversationEventHandlerDeps {
	liveResponseUpdater: {
		push: (text: string) => void;
		cancel: () => void;
		flush: () => void;
	};
	reasoningUpdater: {
		push: (text: string) => void;
		cancel: () => void;
		flush: () => void;
	};
	appendMessages: (messages: any[]) => void;
	setMessages: (updater: (prev: any[]) => any[]) => void;
	setLiveResponse: (response: any) => void;
	trimMessages: (messages: any[]) => any[];
	annotateCommandMessage: (msg: CommandMessage) => CommandMessage;
}

/**
 * Create a conversation event handler that processes streaming events.
 * The handler mutates the provided state object and calls deps methods.
 *
 * @param deps - Injected dependencies for state updates
 * @param state - Mutable streaming state object
 * @returns Event handler function
 */
export function createConversationEventHandler(
	deps: ConversationEventHandlerDeps,
	state: StreamingState,
): (event: ConversationEvent) => void {
	const {
		liveResponseUpdater,
		reasoningUpdater,
		appendMessages,
		setMessages,
		setLiveResponse,
		trimMessages,
		annotateCommandMessage,
	} = deps;

	return (event: ConversationEvent) => {
		switch (event.type) {
			case 'text_delta': {
				state.accumulatedText += event.delta;
				liveResponseUpdater.push(state.accumulatedText);
				return;
			}

			case 'reasoning_delta': {
				const fullReasoningText = event.fullText ?? '';
				// Only show reasoning text after what was already flushed
				const newReasoningText = fullReasoningText.slice(
					state.flushedReasoningLength,
				);
				state.accumulatedReasoningText = newReasoningText;

				if (!newReasoningText.trim()) return;
				reasoningUpdater.push(newReasoningText);
				return;
			}

			case 'tool_started': {
				// Flush reasoning state
				if (state.accumulatedReasoningText.trim()) {
					reasoningUpdater.flush();
					state.flushedReasoningLength +=
						state.accumulatedReasoningText.length;
					state.accumulatedReasoningText = '';
					state.currentReasoningMessageId = null;
				}

				// Flush any accumulated text before showing the tool call
				if (state.accumulatedText.trim()) {
					const textMessage: BotMessage = {
						id: Date.now() + 1,
						sender: 'bot',
						text: state.accumulatedText,
					};
					appendMessages([textMessage]);
					state.accumulatedText = '';
					state.textWasFlushed = true;
					liveResponseUpdater.cancel();
					setLiveResponse(null);
				}

				// Emit a "pending" command message when tool starts running
				const {toolCallId, toolName, arguments: rawArgs} = event;

				// tool_started.arguments may be either an object or a JSON string
				const args = parseToolArguments(rawArgs);
				const command = formatToolCommand(
					toolName,
					args as Record<string, unknown>,
				);

				const pendingMessage: CommandMessage = {
					id: toolCallId ?? String(Date.now()),
					sender: 'command',
					status: 'running',
					command,
					output: '',
					callId: toolCallId,
					toolName,
					toolArgs: args,
				};

				appendMessages([pendingMessage]);
				return;
			}

			case 'command_message': {
				const cmdMsg = event.message;
				const annotated = annotateCommandMessage(cmdMsg as CommandMessage);

				const messagesToAdd: BotMessage[] = [];

				// Flush reasoning state
				if (state.accumulatedReasoningText.trim()) {
					reasoningUpdater.flush();
					state.flushedReasoningLength +=
						state.accumulatedReasoningText.length;
					state.accumulatedReasoningText = '';
					state.currentReasoningMessageId = null;
				}

				// Flush any accumulated text before adding command message
				if (state.accumulatedText.trim()) {
					const textMessage: BotMessage = {
						id: Date.now() + 1,
						sender: 'bot',
						text: state.accumulatedText,
					};
					messagesToAdd.push(textMessage);
					state.accumulatedText = '';
					state.textWasFlushed = true;
				}

				if (messagesToAdd.length > 0) {
					appendMessages(messagesToAdd);
					liveResponseUpdater.cancel();
					setLiveResponse(null);
				}

				// Replace pending message with completed one, or add new if not found
				setMessages((prev: any[]) => {
					const pendingIndex = annotated.callId
						? prev.findIndex(
								(msg: any) =>
									msg.sender === 'command' &&
									msg.callId === annotated.callId &&
									msg.status === 'running',
							)
						: -1;

					if (pendingIndex !== -1) {
						const next = [...prev];
						next[pendingIndex] = annotated;
						return trimMessages(next);
					}

					return trimMessages([...prev, annotated]);
				});
				return;
			}

			case 'retry': {
				const systemMessage: SystemMessage = {
					id: Date.now(),
					sender: 'system',
					text: `Tool hallucination detected (${event.toolName}). Retrying... (Attempt ${event.attempt}/${event.maxRetries})`,
				};
				setMessages((prev: any[]) => [...prev, systemMessage]);
				return;
			}

			default:
				// Ignore unknown events (approval_required, final, error handled elsewhere)
				return;
		}
	};
}
