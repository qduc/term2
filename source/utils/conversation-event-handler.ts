/**
 * Factory for creating conversation event handlers.
 * Extracted from use-conversation.ts to enable testing.
 */

import type { ConversationEvent } from '../services/conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { parseToolArguments, formatToolCommand, type StreamingState } from './conversation-utils.js';

/**
 * Message types used by the event handler.
 */
export interface BotMessage {
  id: number;
  sender: 'bot';
  text: string;
}

export interface SystemMessage {
  id: number;
  sender: 'system';
  text: string;
}

export type UIMessage = {
  id: string | number;
  sender: string;
  callId?: string;
  status?: string;
};

export interface ConversationEventHandlerDeps<
  MessageT extends UIMessage = UIMessage,
  CommandMessageT extends CommandMessage = CommandMessage,
> {
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
  appendMessages: (messages: MessageT[]) => void;
  setMessages: (updater: (prev: MessageT[]) => MessageT[]) => void;
  setLiveResponse: (response: { id: number; sender: 'bot'; text: string } | null) => void;
  trimMessages: (messages: MessageT[]) => MessageT[];
  annotateCommandMessage: (msg: CommandMessageT) => CommandMessageT;
}

/**
 * Create a conversation event handler that processes streaming events.
 * The handler mutates the provided state object and calls deps methods.
 *
 * @param deps - Injected dependencies for state updates
 * @param state - Mutable streaming state object
 * @returns Event handler function
 */
export function createConversationEventHandler<
  MessageT extends UIMessage = UIMessage,
  CommandMessageT extends CommandMessage = CommandMessage,
>(
  deps: ConversationEventHandlerDeps<MessageT, CommandMessageT>,
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
        const newReasoningText = fullReasoningText.slice(state.flushedReasoningLength);
        state.accumulatedReasoningText = newReasoningText;

        if (!newReasoningText.trim()) return;
        reasoningUpdater.push(newReasoningText);
        return;
      }

      case 'tool_started': {
        // Flush reasoning state
        if (state.accumulatedReasoningText.trim()) {
          reasoningUpdater.flush();
          state.flushedReasoningLength += state.accumulatedReasoningText.length;
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
          appendMessages([textMessage as unknown as MessageT]);
          state.accumulatedText = '';
          state.textWasFlushed = true;
          liveResponseUpdater.cancel();
          setLiveResponse(null);
        }

        // Emit a "pending" command message when tool starts running
        const { toolCallId, toolName, arguments: rawArgs } = event;

        // tool_started.arguments may be either an object or a JSON string
        const args = parseToolArguments(rawArgs);
        const command = formatToolCommand(toolName, args as Record<string, unknown>);

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

        appendMessages([pendingMessage as unknown as MessageT]);
        return;
      }

      case 'command_message': {
        const cmdMsg = event.message;
        const annotated = annotateCommandMessage(cmdMsg as CommandMessageT);

        const messagesToAdd: BotMessage[] = [];

        // Flush reasoning state
        if (state.accumulatedReasoningText.trim()) {
          reasoningUpdater.flush();
          state.flushedReasoningLength += state.accumulatedReasoningText.length;
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
          appendMessages(messagesToAdd as unknown as MessageT[]);
          liveResponseUpdater.cancel();
          setLiveResponse(null);
        }

        // Replace pending message with completed one, or add new if not found
        setMessages((prev) => {
          const pendingIndex = annotated.callId
            ? prev.findIndex(
                (msg) => msg.sender === 'command' && msg.callId === annotated.callId && msg.status === 'running',
              )
            : -1;

          if (pendingIndex !== -1) {
            const next = [...prev];
            next[pendingIndex] = annotated as unknown as MessageT;
            return trimMessages(next);
          }

          return trimMessages([...prev, annotated as unknown as MessageT]);
        });
        return;
      }

      case 'retry': {
        const systemMessage: SystemMessage = {
          id: Date.now(),
          sender: 'system',
          text: `Tool hallucination detected (${event.toolName}). Retrying... (Attempt ${event.attempt}/${event.maxRetries})`,
        };
        setMessages((prev) => [...prev, systemMessage as unknown as MessageT]);
        return;
      }

      case 'usage_update':
        // Usage updates are handled separately in streaming-session-factory.ts
        // This case exists for exhaustiveness and to document the event flow
        return;

      default:
        // Ignore unknown events (approval_required, final, error handled elsewhere)
        return;
    }
  };
}
