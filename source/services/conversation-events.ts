import type { CommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { ApprovalDescriptor } from '../contracts/conversation.js';

export type ConversationEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolStartedEvent
  | CommandMessageEvent
  | ApprovalRequiredEvent
  | FinalResponseEvent
  | ErrorEvent
  | RetryEvent;

export interface RetryEvent {
  type: 'retry';
  toolName: string;
  attempt: number;
  maxRetries: number;
  errorMessage: string;
}

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

/**
 * Emitted when a tool is called but hasn't completed yet.
 * Allows UI to show immediate feedback that a tool is running.
 */
export interface ToolStartedEvent {
  type: 'tool_started';
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

export interface ApprovalRequiredEvent {
  type: 'approval_required';
  approval: Omit<ApprovalDescriptor, 'rawInterruption'>;
}

export interface CommandMessageEvent {
  type: 'command_message';
  message: CommandMessage;
}

export interface FinalResponseEvent {
  type: 'final';
  finalText: string;
  reasoningText?: string;
  /** Command messages that were not already streamed live. */
  commandMessages?: CommandMessageEvent['message'][];
  /** Token usage for this turn. */
  usage?: NormalizedUsage;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
  kind?: string;
}
