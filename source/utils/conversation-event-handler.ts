/**
 * Factory for creating conversation event handlers.
 * Extracted from use-conversation.ts to enable testing.
 */

import type { ConversationEvent } from '../services/conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { parseToolArguments, formatToolCommand, type StreamingState } from './conversation-utils.js';

/**
 * Finds the last safe Markdown block boundary in the text after the search start index.
 * A safe boundary occurs at paragraph endings, closed code blocks, headings, or thematic breaks,
 * while strictly avoiding breaking inside an open code block.
 */
export function findLastSafeBoundary(fullText: string, searchStartIndex: number): number {
  const boundaryRegex = /\n\n|\n```(?:\n|$)|\n(?:---|[*]{3})(?:\n|$)|\n#{1,6} /g;
  boundaryRegex.lastIndex = searchStartIndex;

  let match;
  let lastSafeIndex = -1;

  while ((match = boundaryRegex.exec(fullText)) !== null) {
    const isCodeBlock = match[0].startsWith('\n```');

    let codeBlockCount = 0;
    const codeBlockRegex = /(?:^|\n)```/g;
    let cbMatch;
    while ((cbMatch = codeBlockRegex.exec(fullText)) !== null) {
      if (cbMatch.index < match.index) {
        codeBlockCount++;
      } else {
        break;
      }
    }
    const insideCodeBlock = codeBlockCount % 2 !== 0;

    if (isCodeBlock) {
      if (insideCodeBlock) {
        lastSafeIndex = match.index + match[0].length;
      }
    } else {
      if (!insideCodeBlock) {
        if (match[0].startsWith('\n#')) {
          lastSafeIndex = match.index + 1;
        } else {
          lastSafeIndex = match.index + match[0].length;
        }
      }
    }
  }

  return lastSafeIndex;
}

/**
 * Message types used by the event handler.
 */
export interface BotMessage {
  id: string;
  sender: 'bot';
  text: string;
  status?: 'streaming' | 'finalized';
}

export interface SystemMessage {
  id: string;
  sender: 'system';
  text: string;
}

export interface ReasoningMessage {
  id: string;
  sender: 'reasoning';
  text: string;
  status?: 'finalized';
}

export interface SubagentActivityMessage {
  id: string;
  sender: 'subagent';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  agentId: string;
  role: string;
  task: string;
  tools: string[];
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
  botResponseUpdater: {
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
  createMessageId: () => string;
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
    botResponseUpdater,
    reasoningUpdater,
    appendMessages,
    setMessages,
    createMessageId,
    trimMessages,
    annotateCommandMessage,
  } = deps;

  const activeRunningToolCallIds = new Set<string>();

  const markCurrentReasoningFinalized = () => {
    if (!state.currentReasoningMessageId) {
      return;
    }

    const currentReasoningMessageId = state.currentReasoningMessageId;
    const finalizedText = state.accumulatedReasoningText;
    setMessages((prev) => {
      const index = prev.findIndex((msg) => msg.id === currentReasoningMessageId);
      if (index === -1) return prev;

      const current = prev[index];
      if (current.sender !== 'reasoning') {
        return prev;
      }

      const next = prev.slice();
      next[index] = { ...current, status: 'finalized', text: finalizedText };
      return trimMessages(next);
    });
  };

  const flushReasoning = () => {
    if (!state.accumulatedReasoningText.trim()) {
      return;
    }

    reasoningUpdater.flush();
    state.flushedReasoningLength += state.accumulatedReasoningText.length;
    markCurrentReasoningFinalized();
    state.accumulatedReasoningText = '';
    state.currentReasoningMessageId = null;
  };

  const flushBotText = () => {
    const unescapedText = state.accumulatedText.slice(state.flushedTextLength);
    if (!unescapedText.trim()) {
      state.flushedTextLength += unescapedText.length;
      return;
    }

    // Do NOT call botResponseUpdater.flush() here. flushBotText writes the
    // finalized text directly via setMessages/appendMessages below. Calling
    // flush() first would write the same text a second time (creating or
    // updating the live-streaming message slot), making the subsequent write
    // either a redundant overwrite (when currentBotMessageId is set after
    // flush) or causing a double message (if flush is deferred and the slot
    // doesn't exist yet at evaluation time). Callers that want to discard the
    // in-flight live tail should call botResponseUpdater.cancel() after this.
    state.flushedTextLength += unescapedText.length;
    state.textWasFlushed = true;

    if (state.currentBotMessageId) {
      const botMessageId = state.currentBotMessageId;
      setMessages((prev) => {
        const index = prev.findIndex((msg) => msg.id === botMessageId);
        if (index === -1) return prev;
        const current = prev[index];
        if (current.sender !== 'bot') return prev;
        const next = prev.slice();
        next[index] = { ...current, status: 'finalized', text: unescapedText };
        return trimMessages(next);
      });
      state.currentBotMessageId = null;
    } else {
      const finalizedMessage: BotMessage = {
        id: createMessageId(),
        sender: 'bot',
        status: 'finalized',
        text: unescapedText,
      };
      appendMessages([finalizedMessage as unknown as MessageT]);
    }
  };

  const resetBotTextTracking = () => {
    state.accumulatedText = '';
    state.flushedTextLength = 0;
    state.currentBotMessageId = null;
  };

  return (event: ConversationEvent) => {
    switch (event.type) {
      case 'text_delta': {
        state.accumulatedText += event.delta;

        let newBotText = state.accumulatedText.slice(state.flushedTextLength);

        const lastBoundaryIndex = findLastSafeBoundary(state.accumulatedText, state.flushedTextLength);
        if (lastBoundaryIndex !== -1) {
          const finalizedText = state.accumulatedText.slice(state.flushedTextLength, lastBoundaryIndex);
          newBotText = state.accumulatedText.slice(lastBoundaryIndex);

          if (finalizedText.trim()) {
            botResponseUpdater.cancel();
            if (state.currentBotMessageId) {
              const botMessageId = state.currentBotMessageId;
              state.currentBotMessageId = null;
              setMessages((prev) => {
                const index = prev.findIndex((m) => m.id === botMessageId);
                if (index === -1) return prev;
                const current = prev[index];
                if (current.sender !== 'bot') return prev;
                const next = prev.slice();
                next[index] = { ...current, status: 'finalized', text: finalizedText };
                return trimMessages(next);
              });
            } else {
              const finalizedMessage: BotMessage = {
                id: createMessageId(),
                sender: 'bot',
                status: 'finalized',
                text: finalizedText,
              };
              appendMessages([finalizedMessage as unknown as MessageT]);
            }
            state.textWasFlushed = true;
            state.flushedTextLength += finalizedText.length;
          }
        }

        if (!newBotText.trim()) return;
        botResponseUpdater.push(newBotText);
        return;
      }

      case 'reasoning_delta': {
        const fullReasoningText = event.fullText ?? '';
        // Continuation streams can restart fullText after a tool, while the UI
        // still remembers the pre-tool reasoning length that was flushed.
        if (state.flushedReasoningLength > 0 && !state.accumulatedReasoningText && event.fullText === event.delta) {
          state.flushedReasoningLength = 0;
        }
        // Only show reasoning text after what was already flushed
        let newReasoningText = fullReasoningText.slice(state.flushedReasoningLength);

        const lastBoundaryIndex = findLastSafeBoundary(fullReasoningText, state.flushedReasoningLength);
        if (lastBoundaryIndex !== -1) {
          const finalizedText = fullReasoningText.slice(state.flushedReasoningLength, lastBoundaryIndex);
          newReasoningText = fullReasoningText.slice(lastBoundaryIndex);

          if (finalizedText.trim()) {
            reasoningUpdater.cancel();
            if (state.currentReasoningMessageId) {
              state.accumulatedReasoningText = finalizedText;
              markCurrentReasoningFinalized();
              state.currentReasoningMessageId = null;
            } else {
              const finalizedMessage: ReasoningMessage = {
                id: createMessageId(),
                sender: 'reasoning',
                status: 'finalized',
                text: finalizedText,
              };
              appendMessages([finalizedMessage as unknown as MessageT]);
            }
            state.flushedReasoningLength += finalizedText.length;
          }
        }

        state.accumulatedReasoningText = newReasoningText;
        if (!newReasoningText.trim()) return;
        reasoningUpdater.push(newReasoningText);
        return;
      }

      case 'tool_started': {
        // Flush reasoning state
        flushReasoning();

        // Flush any accumulated text before showing the tool call
        flushBotText();
        resetBotTextTracking();
        botResponseUpdater.cancel();

        // Emit a "pending" command message when tool starts running
        const { toolCallId, toolName, arguments: rawArgs } = event;

        // tool_started.arguments may be either an object or a JSON string
        const args = parseToolArguments(rawArgs);
        const command = formatToolCommand(toolName, args as Record<string, unknown>);

        const pendingMessage: CommandMessage = {
          id: toolCallId ?? createMessageId(),
          sender: 'command',
          status: 'running',
          command,
          output: '',
          callId: toolCallId,
          toolName,
          toolArgs: args,
        };

        if (toolCallId && activeRunningToolCallIds.has(toolCallId)) {
          return;
        }

        if (toolCallId) {
          activeRunningToolCallIds.add(toolCallId);
        }

        appendMessages([pendingMessage as unknown as MessageT]);
        return;
      }

      case 'command_message': {
        const cmdMsg = event.message;
        if (cmdMsg.callId) {
          activeRunningToolCallIds.delete(cmdMsg.callId);
        }
        const annotated = annotateCommandMessage(cmdMsg as CommandMessageT);

        // Flush reasoning state
        flushReasoning();

        // Flush any accumulated text before adding command message
        flushBotText();
        resetBotTextTracking();
        botResponseUpdater.cancel();

        // Replace pending message with completed one, or add new if not found
        setMessages((prev) => {
          const pendingIndex = annotated.callId
            ? prev.findIndex(
                (msg) => msg.sender === 'command' && msg.callId === annotated.callId && msg.status === 'running',
              )
            : prev.findIndex((msg) => msg.sender === 'command' && !msg.callId && msg.status === 'running');

          if (pendingIndex !== -1) {
            const next = [...prev];
            next[pendingIndex] = annotated as unknown as MessageT;
            return trimMessages(next);
          }

          return trimMessages([...prev, annotated as unknown as MessageT]);
        });
        return;
      }

      case 'subagent_started': {
        appendMessages([
          {
            id: `subagent-${event.agentId}`,
            sender: 'subagent',
            status: 'running',
            agentId: event.agentId,
            role: event.role,
            task: event.task,
            tools: [],
          } as unknown as MessageT,
        ]);
        return;
      }

      case 'subagent_tool_started': {
        setMessages((prev) => {
          const index = prev.findIndex((msg) => msg.sender === 'subagent' && (msg as any).agentId === event.agentId);
          const toolLabels =
            event.commandMessages
              ?.map((message) => message.command)
              .filter((command): command is string => Boolean(command)) ?? [];
          const newTools = toolLabels.length > 0 ? toolLabels : [event.toolName];
          const appendTool = (message: any) => ({
            ...message,
            status: 'running',
            role: message.role ?? event.role,
            tools: [...(Array.isArray(message.tools) ? message.tools : []), ...newTools].slice(-3),
          });

          if (index === -1) {
            return trimMessages([
              ...prev,
              {
                id: `subagent-${event.agentId}`,
                sender: 'subagent',
                status: 'running',
                agentId: event.agentId,
                role: event.role,
                task: '',
                tools: newTools.slice(-3),
              } as unknown as MessageT,
            ]);
          }

          const next = [...prev];
          next[index] = appendTool(next[index]) as unknown as MessageT;
          return trimMessages(next);
        });
        return;
      }

      case 'subagent_completed': {
        setMessages((prev) => {
          return trimMessages(
            prev.filter((msg) => !(msg.sender === 'subagent' && (msg as any).agentId === event.result.agentId)),
          );
        });
        return;
      }

      case 'retry': {
        const text =
          event.retryType === 'flex_service_tier'
            ? 'Flex service tier timed out. Falling back to standard service tier and retrying...'
            : `Tool hallucination detected (${event.toolName}). Retrying... (Attempt ${event.attempt}/${event.maxRetries})`;
        const systemMessage: SystemMessage = {
          id: createMessageId(),
          sender: 'system',
          text,
        };
        setMessages((prev) => [...prev, systemMessage as unknown as MessageT]);
        return;
      }

      case 'final':
        if (event.finalText?.trim()) {
          state.accumulatedText = event.finalText;
        }

        // Finalize any trailing reasoning message that was never followed by a tool call.
        // tool_started and command_message already call flushReasoning; this handles
        // the text-only turn path where neither fires before the stream closes.
        flushReasoning();
        flushBotText();
        return;

      case 'usage_update':
        // Usage updates are handled separately in streaming-session-factory.ts
        // This case exists for exhaustiveness and to document the event flow
        return;

      default:
        // Ignore unknown events (approval_required, error handled elsewhere)
        return;
    }
  };
}
