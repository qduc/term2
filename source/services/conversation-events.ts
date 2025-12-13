export type ConversationEvent =
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| CommandMessageEvent
	| ApprovalRequiredEvent
	| FinalResponseEvent
	| ErrorEvent;

/**
 * Transport-friendly text streaming event.
 *
 * - `delta` is the new chunk.
 * - `fullText` is the accumulated text so far (optional but convenient for UIs).
 */
export interface TextDeltaEvent {
	type: 'text_delta';
	delta: string;
	fullText?: string;
}

/**
 * Transport-friendly reasoning streaming event.
 */
export interface ReasoningDeltaEvent {
	type: 'reasoning_delta';
	delta: string;
	fullText?: string;
}

export interface ApprovalRequiredEvent {
	type: 'approval_required';
	approval: {
		agentName: string;
		toolName: string;
		argumentsText: string;
		/** Optional provider-specific tool call id (when available). */
		callId?: string;
	};
}

export interface CommandMessageEvent {
	type: 'command_message';
	message: {
		id: string;
		sender: 'command';
		command: string;
		output: string;
		success?: boolean;
		failureReason?: string;
		isApprovalRejection?: boolean;
	};
}

export interface FinalResponseEvent {
	type: 'final';
	finalText: string;
	reasoningText?: string;
	/** Command messages that were not already streamed live. */
	commandMessages?: CommandMessageEvent['message'][];
}

export interface ErrorEvent {
	type: 'error';
	message: string;
	kind?: string;
}
