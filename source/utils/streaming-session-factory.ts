/**
 * Factory for creating streaming session helpers.
 * Extracted from use-conversation.ts to enable testing.
 */

import type { ConversationEvent } from '../services/conversation-events.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import {
  createConversationEventHandler,
  type ConversationEventHandlerDeps,
  type UIMessage,
} from './conversation-event-handler.js';
import { createStreamingState, type StreamingState } from './conversation-utils.js';
import { createStreamingUpdateCoordinator } from './streaming-updater.js';
import type { NormalizedUsage } from './token-usage.js';
import { createMessageIdFactory } from '../hooks/message-id.js';

export interface StreamingSessionFactoryDeps<MessageT extends UIMessage = UIMessage> {
  appendMessages: ConversationEventHandlerDeps<MessageT>['appendMessages'];
  setMessages: ConversationEventHandlerDeps<MessageT>['setMessages'];
  trimMessages: ConversationEventHandlerDeps<MessageT>['trimMessages'];
  annotateCommandMessage: ConversationEventHandlerDeps<MessageT>['annotateCommandMessage'];
  loggingService: ILoggingService;
  setLastUsage: (usage: NormalizedUsage) => void;
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

export function createStreamingSession<MessageT extends UIMessage = UIMessage>(
  deps: StreamingSessionFactoryDeps<MessageT>,
  label: string,
): StreamingSession {
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
      return deps.trimMessages([
        ...prev,
        {
          id: newId,
          sender: 'bot',
          status: 'streaming',
          text: newBotText,
        },
      ] as unknown as MessageT[]);
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
      return deps.trimMessages([
        ...prev,
        {
          id: newId,
          sender: 'reasoning',
          text: newReasoningText,
        },
      ] as unknown as MessageT[]);
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
      if (event.usage) {
        deps.loggingService.debug(`UI received final usage (${label})`, { usage: event.usage });
        streamingState.latestUsage = event.usage;
        deps.setLastUsage(event.usage);
      } else {
        deps.loggingService.debug(`UI final event has no usage (${label})`);
      }
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
