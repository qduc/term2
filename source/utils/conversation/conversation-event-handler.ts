/**
 * Factory for creating conversation event handlers.
 * Extracted from use-conversation.ts to enable testing.
 */

import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import type {
  BotMessage,
  CommandMessage,
  Message,
  ReasoningMessage,
  SubagentActivityMessage,
  SystemMessage,
} from '../../types/message.js';
import { isCommandMessage, isSubagentActivityMessage } from '../../types/message.js';
import { isResultToolEvent } from '../../components/message/SubagentActivityMessage.js';
import { parseToolArguments, formatToolCommand, type StreamingState } from './conversation-utils.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import { findMarkdownCommitOffset } from './markdown-commit-frontier.js';

function countOutputLines(output: string | undefined): number {
  if (!output) return 0;
  const trimmed = output.trim();
  if (trimmed === 'No matches found.' || trimmed.startsWith('No files found')) {
    return 0;
  }
  return trimmed.split('\n').filter((line) => line.trim().length > 0).length;
}

export interface ConversationEventHandlerDeps {
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
  appendMessages: (messages: Message[]) => void;
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  createMessageId: () => string;
  trimMessages: (messages: Message[]) => Message[];
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
    botResponseUpdater,
    reasoningUpdater,
    appendMessages,
    setMessages,
    createMessageId,
    trimMessages,
    annotateCommandMessage,
  } = deps;

  const activeRunningToolCallIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  const pendingSubagentToolCalls = new Map<string, { role?: string; task?: string; [key: string]: unknown }>();
  const foregroundSubagentToolCallIds = new Set<string>();
  const seenSubagentAgentIds = new Set<string>();

  // Foreground delegation is rendered by SubagentActivityMessage, so its
  // CommandMessage would duplicate the activity row. Background delegation is
  // an ordinary command message; its lifecycle is independently routed using
  // the event's `async` metadata.
  const isForegroundSubagentDelegationTool = (toolName: string | undefined, args?: unknown): boolean => {
    return (
      toolName === 'run_subagent' &&
      (!args || typeof args !== 'object' || (args as Record<string, unknown>).execution !== 'background')
    );
  };

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
    if (state.accumulatedReasoningText.trim()) {
      reasoningUpdater.flush();
      state.flushedReasoningLength += state.accumulatedReasoningText.length;
    }

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
      appendMessages([finalizedMessage]);
    }
  };

  const resetBotTextTracking = () => {
    state.accumulatedText = '';
    state.flushedTextLength = 0;
    state.currentBotMessageId = null;
  };

  const commitBotTextPrefix = (commitOffset: number) => {
    const committedText = state.accumulatedText.slice(state.flushedTextLength, commitOffset);
    const liveText = state.accumulatedText.slice(commitOffset);
    const previousLiveMessageId = state.currentBotMessageId;
    const finalizedMessageId = previousLiveMessageId ?? createMessageId();
    const nextLiveMessageId = liveText.trim() ? createMessageId() : null;

    botResponseUpdater.cancel();
    state.flushedTextLength = commitOffset;
    state.textWasFlushed = true;
    state.currentBotMessageId = nextLiveMessageId;

    setMessages((prev) => {
      const finalizedMessage: BotMessage = {
        id: finalizedMessageId,
        sender: 'bot',
        status: 'finalized',
        text: committedText,
      };
      const next = prev.slice();
      const liveIndex =
        previousLiveMessageId === null ? -1 : next.findIndex((message) => message.id === previousLiveMessageId);

      if (liveIndex === -1) {
        next.push(finalizedMessage);
      } else {
        const current = next[liveIndex];
        next[liveIndex] = current.sender === 'bot' ? { ...current, ...finalizedMessage } : finalizedMessage;
      }

      if (nextLiveMessageId !== null) {
        const streamingMessage: BotMessage = {
          id: nextLiveMessageId,
          sender: 'bot',
          status: 'streaming',
          text: liveText,
        };
        next.splice(liveIndex === -1 ? next.length : liveIndex + 1, 0, streamingMessage);
      }

      return trimMessages(next);
    });
  };

  return (event: ConversationEvent) => {
    switch (event.type) {
      case 'text_delta': {
        flushReasoning();
        state.accumulatedText += event.delta;
        const commitOffset = findMarkdownCommitOffset(state.accumulatedText, state.flushedTextLength);
        if (commitOffset > state.flushedTextLength) {
          commitBotTextPrefix(commitOffset);
          return;
        }

        const liveText = state.accumulatedText.slice(state.flushedTextLength);
        if (!liveText.trim()) return;
        botResponseUpdater.push(liveText);
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

        const lastBoundaryIndex = findMarkdownCommitOffset(fullReasoningText, state.flushedReasoningLength);
        if (lastBoundaryIndex > state.flushedReasoningLength) {
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
              appendMessages([finalizedMessage]);
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
        const { toolCallId, toolName, arguments: rawArgs } = event;

        const args = parseToolArguments(rawArgs);
        if (isForegroundSubagentDelegationTool(toolName, args)) {
          // Flush reasoning state
          flushReasoning();

          // Flush any accumulated text before showing the tool call
          flushBotText();
          resetBotTextTracking();
          botResponseUpdater.cancel();

          if (toolCallId) {
            foregroundSubagentToolCallIds.add(toolCallId);
            pendingSubagentToolCalls.set(toolCallId, args as { role?: string; task?: string; [key: string]: unknown });
          }
          return;
        }

        // Flush reasoning state
        flushReasoning();

        // Flush any accumulated text before showing the tool call
        flushBotText();
        resetBotTextTracking();
        botResponseUpdater.cancel();

        // Emit a "pending" command message when tool is called
        // tool_started.arguments may be either an object or a JSON string
        const command = formatToolCommand(toolName, args as Record<string, unknown>);

        const pendingMessage: CommandMessage = {
          id: toolCallId ?? createMessageId(),
          sender: 'command',
          status: 'pending',
          command,
          output: '',
          callId: toolCallId,
          toolName,
          toolArgs: args,
        };

        if (toolCallId && seenToolCallIds.has(toolCallId)) {
          return;
        }

        if (toolCallId) {
          seenToolCallIds.add(toolCallId);
        }

        appendMessages([pendingMessage]);
        return;
      }

      case 'tool_dispatched': {
        const { toolCallId } = event;
        if (!toolCallId) return;
        activeRunningToolCallIds.add(toolCallId);
        setMessages((prev) => {
          const index = prev.findIndex(
            (msg) => msg.sender === 'command' && msg.callId === toolCallId && msg.status === 'pending',
          );
          if (index === -1) return prev;
          const current = prev[index];
          if (current.sender !== 'command') return prev;
          const next = [...prev];
          next[index] = { ...current, status: 'running' };
          return trimMessages(next);
        });
        return;
      }

      case 'command_message': {
        const cmdMsg = event.message;
        const hadPendingCommand = cmdMsg.callId !== undefined && activeRunningToolCallIds.delete(cmdMsg.callId);

        const wasForegroundSubagent =
          cmdMsg.callId !== undefined && foregroundSubagentToolCallIds.delete(cmdMsg.callId);
        if (wasForegroundSubagent && cmdMsg.callId !== undefined) {
          const statusText =
            typeof cmdMsg.output === 'string'
              ? cmdMsg.output.match(/^Status:\s*(\w+)/im)?.[1]?.toLowerCase()
              : undefined;
          const fallbackStatus =
            cmdMsg.status === 'failed'
              ? 'failed'
              : statusText === 'interrupted'
              ? 'interrupted'
              : statusText === 'cancelled'
              ? 'cancelled'
              : statusText === 'failed'
              ? 'failed'
              : statusText === 'running'
              ? 'backgrounded'
              : 'completed';
          setMessages((prev) =>
            trimMessages(
              prev.map((msg) =>
                isSubagentActivityMessage(msg) && msg.callId === cmdMsg.callId && msg.status === 'running'
                  ? { ...msg, status: fallbackStatus }
                  : msg,
              ),
            ),
          );
          return;
        }
        // Foreground run_subagent is displayed via SubagentActivityMessage;
        // skip its completion so we do not create a duplicate CommandMessage.
        // Calls from legacy records without a preceding tool_started are also
        // foreground unless their arguments explicitly choose background.
        if (!hadPendingCommand && isForegroundSubagentDelegationTool(cmdMsg.toolName, cmdMsg.toolArgs)) {
          return;
        }

        const annotated = annotateCommandMessage(cmdMsg);

        // Flush reasoning state
        flushReasoning();

        // Flush any accumulated text before adding command message
        flushBotText();
        resetBotTextTracking();
        botResponseUpdater.cancel();

        // Replace pending/running message with completed one, or add new if not found
        setMessages((prev) => {
          const pendingIndex = annotated.callId
            ? prev.findIndex(
                (msg) =>
                  msg.sender === 'command' &&
                  msg.callId === annotated.callId &&
                  (msg.status === 'running' || msg.status === 'pending'),
              )
            : prev.findIndex(
                (msg) =>
                  msg.sender === 'command' && !msg.callId && (msg.status === 'running' || msg.status === 'pending'),
              );

          if (pendingIndex !== -1) {
            const next = [...prev];
            next[pendingIndex] = {
              ...annotated,
              id: prev[pendingIndex].id,
            };
            return trimMessages(next);
          }

          return trimMessages([...prev, annotated]);
        });
        return;
      }

      case 'subagent_transferred': {
        setMessages((prev) => {
          const index = prev.findIndex((msg) => isSubagentActivityMessage(msg) && msg.agentId === event.agentId);
          if (index === -1) return prev;
          const current = prev[index];
          if (!isSubagentActivityMessage(current) || current.status !== 'running') return prev;
          const next = [...prev];
          next[index] = { ...current, status: 'backgrounded' };
          return trimMessages(next);
        });
        return;
      }

      case 'subagent_started': {
        if (event.parentTool === 'ask_mentor') {
          return;
        }
        let matchingCallId: string | undefined;
        for (const [callId, args] of pendingSubagentToolCalls.entries()) {
          if (args && args.role === event.role && args.task === event.task) {
            matchingCallId = callId;
            pendingSubagentToolCalls.delete(callId);
            break;
          }
        }

        if (!matchingCallId) {
          for (const [callId, args] of pendingSubagentToolCalls.entries()) {
            if (args && args.role === event.role) {
              matchingCallId = callId;
              pendingSubagentToolCalls.delete(callId);
              break;
            }
          }
        }

        if (!matchingCallId && pendingSubagentToolCalls.size > 0) {
          const firstKey = pendingSubagentToolCalls.keys().next().value;
          if (firstKey !== undefined) {
            matchingCallId = firstKey;
            pendingSubagentToolCalls.delete(firstKey);
          }
        }

        const subagentMsg: SubagentActivityMessage = {
          id: `subagent-${event.agentId}`,
          sender: 'subagent',
          status: 'running',
          agentId: event.agentId,
          role: event.role,
          task: event.task,
          ...(event.parentTool !== undefined ? { parentTool: event.parentTool } : {}),
          async: event.async,
          tools: [],
        };
        if (matchingCallId !== undefined) {
          subagentMsg.callId = matchingCallId;
        }

        if (seenSubagentAgentIds.has(event.agentId)) {
          return;
        }
        seenSubagentAgentIds.add(event.agentId);
        appendMessages([subagentMsg]);
        return;
      }

      case 'subagent_tool_started': {
        setMessages((prev) => {
          const index = prev.findIndex((msg) => isSubagentActivityMessage(msg) && msg.agentId === event.agentId);
          if (index !== -1) {
            const next = [...prev];
            const current = next[index];
            if (!isSubagentActivityMessage(current) || current.status !== 'running') return prev;
            // Message already exists; keep it live while tools are added on tool end.
            next[index] = { ...current, status: 'running', role: current.role ?? event.role };
            return trimMessages(next);
          }
          // Create the placeholder message with no tools yet
          return trimMessages([
            ...prev,
            {
              id: `subagent-${event.agentId}`,
              sender: 'subagent',
              status: 'running',
              agentId: event.agentId,
              role: event.role,
              task: '',
              tools: [],
            },
          ]);
        });
        return;
      }

      case 'subagent_command_message': {
        setMessages((prev) => {
          const index = prev.findIndex((msg) => isSubagentActivityMessage(msg) && msg.agentId === event.agentId);
          const command = event.message?.command;
          if (!command) return prev;

          const toolName = event.message?.toolName;
          const finishedCommand = (() => {
            let displayCommand = command;

            // Ensure 'shell' prefix is prepended for shell commands
            if (toolName === 'shell' && !displayCommand.startsWith('shell ')) {
              displayCommand = `shell ${displayCommand}`;
            }

            // Determine suffix based on success/output
            let suffix = '';
            if (toolName === 'shell') {
              if (event.message?.success === true) {
                suffix = ' (Success)';
              } else if (event.message?.success === false) {
                suffix = ' (Failed)';
              }
            } else if (toolName === 'grep' || toolName === 'glob') {
              const lines = countOutputLines(event.message?.output);
              suffix = ` (${lines} match${lines !== 1 ? 'es' : ''})`;
            } else {
              if (event.message?.success === true) {
                suffix = ' (Success)';
              } else if (event.message?.success === false) {
                suffix = ' (Failed)';
              }
            }

            return `${displayCommand}${suffix}`;
          })();

          const appendTool = (message: SubagentActivityMessage): SubagentActivityMessage => {
            const currentTools = Array.isArray(message.tools) ? [...message.tools] : [];
            const isWriteTool =
              toolName === TOOL_NAME_CREATE_FILE ||
              toolName === TOOL_NAME_SEARCH_REPLACE ||
              toolName === TOOL_NAME_APPLY_PATCH;

            const itemToAppend = isWriteTool ? event.message : finishedCommand;
            if (!isResultToolEvent(itemToAppend)) {
              return {
                ...message,
                role: message.role ?? event.role,
              };
            }

            currentTools.push(itemToAppend);

            return {
              ...message,
              role: message.role ?? event.role,
              tools: currentTools.slice(-3),
            };
          };

          if (index === -1) {
            const isWriteTool =
              toolName === TOOL_NAME_CREATE_FILE ||
              toolName === TOOL_NAME_SEARCH_REPLACE ||
              toolName === TOOL_NAME_APPLY_PATCH;
            const itemToAppend = isWriteTool ? event.message : finishedCommand;
            const toolsToInit = isResultToolEvent(itemToAppend) ? [itemToAppend] : [];

            return trimMessages([
              ...prev,
              {
                id: `subagent-${event.agentId}`,
                sender: 'subagent',
                status: 'running',
                agentId: event.agentId,
                role: event.role,
                task: '',
                tools: toolsToInit,
              },
            ]);
          }

          const next = [...prev];
          const current = next[index];
          if (!isSubagentActivityMessage(current)) {
            return prev;
          }
          next[index] = appendTool(current);
          return trimMessages(next);
        });
        return;
      }

      case 'subagent_completed': {
        setMessages((prev) => {
          return trimMessages(
            prev.map((msg) => {
              if (isSubagentActivityMessage(msg) && msg.agentId === event.result.agentId) {
                if (msg.status === 'backgrounded') return msg;
                return {
                  ...msg,
                  status: event.result.status,
                  finalText: event.result.finalText,
                };
              }
              return msg;
            }),
          );
        });
        return;
      }

      case 'subagent_interrupted': {
        setMessages((prev) => {
          return trimMessages(
            prev.map((msg) => {
              if (isSubagentActivityMessage(msg) && msg.agentId === event.agentId && msg.status === 'running') {
                return {
                  ...msg,
                  status: 'interrupted',
                  finalText: event.finalText,
                };
              }
              return msg;
            }),
          );
        });
        return;
      }

      case 'retry': {
        let text: string;
        if (event.retryType === 'flex_service_tier') {
          text = 'Flex service tier timed out. Falling back to standard service tier and retrying...';
        } else if (event.retryType === 'conversation_state') {
          text = `Conversation state was rejected by the provider. Rebuilding context and retrying... (Attempt ${event.attempt}/${event.maxRetries})`;
        } else if (event.retryType === 'connection_interrupted') {
          text = `Connection was interrupted before the response completed. Rebuilding context and retrying... (Attempt ${event.attempt}/${event.maxRetries})`;
        } else if (event.retryType === 'upstream') {
          const prefix =
            event.errorKind === 'network'
              ? 'Network connection unavailable'
              : event.errorKind === 'rate_limit'
              ? 'Rate limited'
              : event.errorKind === 'provider'
              ? 'Provider unavailable'
              : 'Upstream error';
          const wait = event.delayMs !== undefined ? ` in ${Math.ceil(event.delayMs / 1000)}s` : '';
          text = `${prefix} — retrying ${event.attempt}/${event.maxRetries}${wait}`;
        } else if (event.retryType === 'parsing_error') {
          text = `Model parsing error detected. Retrying... (Attempt ${event.attempt}/${event.maxRetries})`;
        } else if (event.retryType === 'behavior') {
          text = `Model behavior error detected. Retrying... (Attempt ${event.attempt}/${event.maxRetries})`;
        } else if (event.retryType === 'hallucination') {
          text = `Tool hallucination detected (${event.toolName}). Retrying... (Attempt ${event.attempt}/${event.maxRetries})`;
        } else {
          text = `Retrying... (Attempt ${event.attempt}/${event.maxRetries})`;
        }
        const systemMessage: SystemMessage = {
          id: createMessageId(),
          sender: 'system',
          text,
        };
        setMessages((prev) => [...prev, systemMessage]);
        return;
      }

      case 'retry_exhausted': {
        const systemMessage: SystemMessage = {
          id: createMessageId(),
          sender: 'system',
          text: event.canRetry
            ? `${event.message}\n\nType /retry-turn to try again, or send a new message to move on.`
            : event.message,
        };
        appendMessages([systemMessage]);
        return;
      }

      case 'tool_recovery': {
        const droppedCallIds = new Set(event.droppedCallIds);
        const systemMessage: SystemMessage = {
          id: createMessageId(),
          sender: 'system',
          text: event.message,
        };

        setMessages((prev) => {
          const next = prev.map((message) => {
            if (!isCommandMessage(message) || !message.callId || !droppedCallIds.has(message.callId)) {
              return message;
            }

            const failedMessage: CommandMessage = {
              ...message,
              status: 'failed',
              output: message.output.trim()
                ? message.output
                : 'This tool call was interrupted and was not sent to model history.',
              failureReason: 'Dropped during recovery',
            };

            return failedMessage;
          });

          return trimMessages([...next, systemMessage]);
        });
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

      case 'codex_rate_limits':
        // Codex rate limits are handled separately in streaming-session-factory.ts
        // This case exists for exhaustiveness and to document the event flow
        return;

      // Server-side context compaction, rendered as a start notice that the completion
      // replaces in place.
      //
      // A response carries more than one compaction item (measured on OpenAI: the streamed
      // order is `[compaction, message, compaction]`), so `started` fires more than once per
      // turn. Only the last item becomes history, so a second `started` supersedes the first
      // rather than stacking — otherwise one compaction would print several notices.
      case 'context_compaction_started': {
        const previousId = state.contextCompactionMessageId;
        const systemMessage: SystemMessage = {
          id: createMessageId(),
          sender: 'system',
          text: 'Compacting context...',
        };
        state.contextCompactionMessageId = systemMessage.id;
        setMessages((prev) => [...prev.filter((message) => message.id !== previousId), systemMessage]);
        return;
      }

      case 'context_compaction_completed': {
        // `inputTokensBefore` is the pre-compaction prompt size: the provider reports the
        // compaction pass's own input tokens, not the compacted result. There is no
        // "after" number to pair it with, so the line states only what was compacted from.
        const previousId = state.contextCompactionMessageId;
        const before = event.inputTokensBefore;
        const seconds = event.durationMs > 0 ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : '';
        const text =
          before === undefined
            ? `Compacted context${seconds}.`
            : `Compacted from ${before.toLocaleString('en-US')} tokens${seconds}.`;
        const systemMessage: SystemMessage = { id: createMessageId(), sender: 'system', text };

        state.contextCompactionMessageId = null;
        setMessages((prev) => {
          const index = prev.findIndex((message) => message.id === previousId);
          if (index === -1) return [...prev, systemMessage];
          const next = prev.slice();
          next[index] = systemMessage;
          return next;
        });
        return;
      }

      case 'context_compaction_failed': {
        // `durationMs` is hardcoded 0 at both catch sites, so only the category is shown.
        const previousId = state.contextCompactionMessageId;
        const systemMessage: SystemMessage = {
          id: createMessageId(),
          sender: 'system',
          text: `Context compaction failed (${event.errorCategory}). The turn continues with the full context.`,
        };
        state.contextCompactionMessageId = null;
        setMessages((prev) => [...prev.filter((message) => message.id !== previousId), systemMessage]);
        return;
      }

      default:
        // Ignore unknown events (approval_required, error handled elsewhere)
        return;
    }
  };
}
