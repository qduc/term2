/**
 * Factory for creating streaming session helpers.
 * Extracted from use-conversation.ts to enable testing.
 */

import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import type { ILoggingService } from '../../services/service-interfaces.js';
import {
  createConversationEventHandler,
  type ConversationEventHandlerDeps,
} from '../conversation/conversation-event-handler.js';
import type { BotMessage, ReasoningMessage } from '../../types/message.js';
import { createStreamingState, type StreamingState } from '../conversation/conversation-utils.js';
import { createStreamingUpdateCoordinator } from './streaming-updater.js';
import type { NormalizedUsage } from '../ai/token-usage.js';
import type { CodexRateLimitInfo } from '../../services/conversation/conversation-events.js';
import { createMessageIdFactory } from '../../hooks/message-id.js';

export interface StreamingSessionFactoryDeps {
  appendMessages: ConversationEventHandlerDeps['appendMessages'];
  setMessages: ConversationEventHandlerDeps['setMessages'];
  trimMessages: ConversationEventHandlerDeps['trimMessages'];
  annotateCommandMessage: ConversationEventHandlerDeps['annotateCommandMessage'];
  loggingService: ILoggingService;
  setLastUsage: (usage: NormalizedUsage) => void;
  setCodexRateLimit?: (rateLimit: CodexRateLimitInfo) => void;
  reasoningThrottleMs: number;
  now?: () => number;
  createStreamingState?: () => StreamingState;
  createStreamingUpdateCoordinator?: typeof createStreamingUpdateCoordinator;
  createConversationEventHandler?: typeof createConversationEventHandler;
}

export interface StreamingSession {
  botResponseUpdater: ConversationEventHandlerDeps['botResponseUpdater'];
  reasoningUpdater: ConversationEventHandlerDeps['reasoningUpdater'];
  streamingState: StreamingState;
  applyConversationEvent: (event: ConversationEvent) => void;
}

export function createStreamingSession(deps: StreamingSessionFactoryDeps, label: string): StreamingSession {
  const now = deps.now ?? Date.now;
  const createState = deps.createStreamingState ?? createStreamingState;
  const createCoordinator = deps.createStreamingUpdateCoordinator ?? createStreamingUpdateCoordinator;
  const createEventHandler = deps.createConversationEventHandler ?? createConversationEventHandler;
  const createMessageId = createMessageIdFactory(now);

  const streamingState = createState();

  const botResponseUpdater = createCoordinator((newBotText: string) => {
    deps.setMessages((prev) => {
      if (streamingState.currentBotMessageId !== null) {
        const index = prev.findIndex((msg) => msg.id === streamingState.currentBotMessageId);
        if (index === -1) return prev;
        const current = prev[index];
        if (current.sender !== 'bot') {
          return prev;
        }
        const next = prev.slice();
        next[index] = { ...current, status: 'streaming', text: newBotText };
        return deps.trimMessages(next);
      }

      const newId = createMessageId();
      streamingState.currentBotMessageId = newId;
      const streamingMessage: BotMessage = {
        id: newId,
        sender: 'bot',
        status: 'streaming',
        text: newBotText,
      };
      return deps.trimMessages([...prev, streamingMessage]);
    });
  }, 150);

  const reasoningUpdater = createCoordinator((newReasoningText: string) => {
    deps.setMessages((prev) => {
      if (streamingState.currentReasoningMessageId !== null) {
        const index = prev.findIndex((msg) => msg.id === streamingState.currentReasoningMessageId);
        if (index === -1) return prev;
        const current = prev[index];
        if (current.sender !== 'reasoning') {
          return prev;
        }
        const next = prev.slice();
        next[index] = { ...current, text: newReasoningText };
        return deps.trimMessages(next);
      }

      const newId = createMessageId();
      streamingState.currentReasoningMessageId = newId;
      const reasoningMessage: ReasoningMessage = {
        id: newId,
        sender: 'reasoning',
        text: newReasoningText,
      };
      return deps.trimMessages([...prev, reasoningMessage]);
    });
  }, deps.reasoningThrottleMs);

  const baseEventHandler = createEventHandler(
    {
      botResponseUpdater,
      reasoningUpdater,
      appendMessages: deps.appendMessages,
      setMessages: deps.setMessages,
      createMessageId,
      trimMessages: deps.trimMessages,
      annotateCommandMessage: deps.annotateCommandMessage,
    },
    streamingState,
  );

  const applyConversationEvent = (event: ConversationEvent) => {
    if (event.type === 'usage_update') {
      // Emit usage updates in real-time during streaming
      deps.loggingService.debug(`UI received streaming usage (${label})`, { usage: event.usage });
      streamingState.latestUsage = event.usage;
      deps.setLastUsage(event.usage);
    } else if (event.type === 'final') {
      if (event.usage && !streamingState.latestUsage) {
        // No per-turn usage was streamed (e.g. a non-streaming provider). Fall
        // back to the final event's usage so the footer still shows something.
        deps.loggingService.debug(`UI received final usage (${label})`, { usage: event.usage });
        streamingState.latestUsage = event.usage;
        deps.setLastUsage(event.usage);
      } else if (event.usage) {
        // The final event carries the run-cumulative total (the sum of every
        // model turn in the run). The footer is a per-turn indicator, so keep
        // the last streamed turn's usage rather than overwriting it with the
        // run total. The run-cumulative still reaches the session accumulator
        // via result.usage in applyServiceResult.
        deps.loggingService.debug(`UI keeping last streamed turn usage; final carries run total (${label})`, {
          finalUsage: event.usage,
          shownUsage: streamingState.latestUsage,
        });
      } else {
        deps.loggingService.debug(`UI final event has no usage (${label})`);
      }
    } else if (event.type === 'codex_rate_limits' && deps.setCodexRateLimit) {
      deps.loggingService.debug(`UI received Codex rate limits (${label})`, { rateLimits: event.rateLimits });
      deps.setCodexRateLimit(event.rateLimits);
    }
    baseEventHandler(event);
  };

  return {
    botResponseUpdater,
    reasoningUpdater,
    streamingState,
    applyConversationEvent,
  };
}
