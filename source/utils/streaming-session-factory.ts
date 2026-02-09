/**
 * Factory for creating streaming session helpers.
 * Extracted from use-conversation.ts to enable testing.
 */

import type { ConversationEvent } from '../services/conversation-events.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { createConversationEventHandler, type ConversationEventHandlerDeps } from './conversation-event-handler.js';
import { createStreamingState, type StreamingState } from './conversation-utils.js';
import { createStreamingUpdateCoordinator } from './streaming-updater.js';
import type { NormalizedUsage } from './token-usage.js';

export interface StreamingSessionFactoryDeps {
  appendMessages: ConversationEventHandlerDeps['appendMessages'];
  setMessages: ConversationEventHandlerDeps['setMessages'];
  setLiveResponse: ConversationEventHandlerDeps['setLiveResponse'];
  trimMessages: ConversationEventHandlerDeps['trimMessages'];
  annotateCommandMessage: ConversationEventHandlerDeps['annotateCommandMessage'];
  loggingService: ILoggingService;
  setLastUsage: (usage: NormalizedUsage) => void;
  createLiveResponseUpdater: (liveMessageId: number) => ConversationEventHandlerDeps['liveResponseUpdater'];
  reasoningThrottleMs: number;
  now?: () => number;
  createStreamingState?: () => StreamingState;
  createStreamingUpdateCoordinator?: typeof createStreamingUpdateCoordinator;
  createConversationEventHandler?: typeof createConversationEventHandler;
}

export interface StreamingSession {
  liveResponseUpdater: ConversationEventHandlerDeps['liveResponseUpdater'];
  reasoningUpdater: ConversationEventHandlerDeps['reasoningUpdater'];
  streamingState: StreamingState;
  applyConversationEvent: (event: ConversationEvent) => void;
}

export function createStreamingSession(deps: StreamingSessionFactoryDeps, label: string): StreamingSession {
  const now = deps.now ?? Date.now;
  const createState = deps.createStreamingState ?? createStreamingState;
  const createCoordinator = deps.createStreamingUpdateCoordinator ?? createStreamingUpdateCoordinator;
  const createEventHandler = deps.createConversationEventHandler ?? createConversationEventHandler;

  const liveMessageId = now();
  deps.setLiveResponse({
    id: liveMessageId,
    sender: 'bot',
    text: '',
  });
  const liveResponseUpdater = deps.createLiveResponseUpdater(liveMessageId);

  const streamingState = createState();

  const reasoningUpdater = createCoordinator((newReasoningText: string) => {
    deps.setMessages((prev) => {
      if (streamingState.currentReasoningMessageId !== null) {
        const index = prev.findIndex((msg: any) => msg.id === streamingState.currentReasoningMessageId);
        if (index === -1) return prev;
        const current = prev[index];
        if (current.sender !== 'reasoning') {
          return prev;
        }
        const next = prev.slice();
        next[index] = { ...current, text: newReasoningText };
        return deps.trimMessages(next as any);
      }

      const newId = now();
      streamingState.currentReasoningMessageId = newId;
      return deps.trimMessages([
        ...prev,
        {
          id: newId,
          sender: 'reasoning',
          text: newReasoningText,
        },
      ]);
    });
  }, deps.reasoningThrottleMs);

  const baseEventHandler = createEventHandler(
    {
      liveResponseUpdater,
      reasoningUpdater,
      appendMessages: deps.appendMessages,
      setMessages: deps.setMessages,
      setLiveResponse: deps.setLiveResponse,
      trimMessages: deps.trimMessages,
      annotateCommandMessage: deps.annotateCommandMessage,
    },
    streamingState,
  );

  const applyConversationEvent = (event: ConversationEvent) => {
    if (event.type === 'final') {
      if (event.usage) {
        deps.loggingService.debug(`UI received final usage (${label})`, { usage: event.usage });
        deps.setLastUsage(event.usage);
      } else {
        deps.loggingService.debug(`UI final event has no usage (${label})`);
      }
    }
    baseEventHandler(event);
  };

  return {
    liveResponseUpdater,
    reasoningUpdater,
    streamingState,
    applyConversationEvent,
  };
}
