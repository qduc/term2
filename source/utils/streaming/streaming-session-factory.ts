/**
 * Factory for creating streaming session helpers.
 * Extracted from use-conversation.ts to enable testing.
 */

import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import type { RunBudgetEvent } from '../../services/agent-runtime/run-budget.js';
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
import { createMessageIdFactory } from '../message-id-factory.js';
import { StreamingSpeedTracker } from './streaming-speed-tracker.js';

export interface StreamingSessionFactoryDeps {
  appendMessages: ConversationEventHandlerDeps['appendMessages'];
  setMessages: ConversationEventHandlerDeps['setMessages'];
  trimMessages: ConversationEventHandlerDeps['trimMessages'];
  annotateCommandMessage: ConversationEventHandlerDeps['annotateCommandMessage'];
  loggingService: ILoggingService;
  setLastUsage: (usage: NormalizedUsage) => void;
  setCodexRateLimit?: (rateLimit: CodexRateLimitInfo) => void;
  setStreamingSpeed?: (speed: { tps: number; ttftMs?: number } | null) => void;
  /**
   * Budget evidence that did not stop the run.
   *
   * In warn mode the run continues past a non-soft stage, so this notice is the
   * only place the human learns the envelope is running out.
   */
  setRunBudgetNotice?: (event: RunBudgetEvent) => void;
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
        status: 'streaming',
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

  const speedTracker = new StreamingSpeedTracker({ startTime: now() });

  const notifySpeed = () => {
    if (!deps.setStreamingSpeed) return;
    const liveTps = speedTracker.getLiveTps(now());
    if (liveTps !== null) {
      deps.setStreamingSpeed({
        tps: liveTps,
        ttftMs: speedTracker.getTtftMs() ?? undefined,
      });
    }
  };

  const applyConversationEvent = (event: ConversationEvent) => {
    if (event.type === 'text_delta') {
      speedTracker.recordDelta(event.delta, now());
      notifySpeed();
    } else if (event.type === 'reasoning_delta') {
      speedTracker.recordDelta(event.delta, now());
      notifySpeed();
    } else if (event.type === 'tool_call_streaming_delta') {
      speedTracker.recordCumulativeChars(event.argumentCharCount, now());
      notifySpeed();
    } else if (event.type === 'usage_update') {
      if (event.usage.completion_tokens) {
        speedTracker.recordUsageTokens(event.usage.completion_tokens, now());
      }
      notifySpeed();
      const currentTps = speedTracker.getSettledTps(event.usage.completion_tokens, now());
      const ttftMs = speedTracker.getTtftMs();
      if (currentTps != null) {
        event.usage.tokens_per_second = currentTps;
      }
      if (ttftMs != null) {
        event.usage.ttft_ms = ttftMs;
      }
      deps.loggingService.debug(`UI received streaming usage (${label})`, { usage: event.usage });
      streamingState.latestUsage = event.usage;
      deps.setLastUsage(event.usage);
    } else if (event.type === 'final') {
      deps.setStreamingSpeed?.(null);
      const completionTokens = event.usage?.completion_tokens ?? streamingState.latestUsage?.completion_tokens;
      const finalTps = speedTracker.getSettledTps(completionTokens, now());
      const ttftMs = speedTracker.getTtftMs();

      if (event.usage && !streamingState.latestUsage) {
        if (finalTps != null) {
          event.usage.tokens_per_second = finalTps;
        }
        if (ttftMs != null) {
          event.usage.ttft_ms = ttftMs;
        }
        deps.loggingService.debug(`UI received final usage (${label})`, { usage: event.usage });
        streamingState.latestUsage = event.usage;
        deps.setLastUsage(event.usage);
      } else if (event.usage) {
        if (streamingState.latestUsage) {
          if (finalTps != null) streamingState.latestUsage.tokens_per_second = finalTps;
          if (ttftMs != null) streamingState.latestUsage.ttft_ms = ttftMs;
        }
        deps.loggingService.debug(`UI keeping last streamed turn usage; final carries run total (${label})`, {
          finalUsage: event.usage,
          shownUsage: streamingState.latestUsage,
        });
      } else {
        if (streamingState.latestUsage) {
          if (finalTps != null) streamingState.latestUsage.tokens_per_second = finalTps;
          if (ttftMs != null) streamingState.latestUsage.ttft_ms = ttftMs;
        }
        deps.loggingService.debug(`UI final event has no usage (${label})`);
      }
    } else if (event.type === 'run_budget' && deps.setRunBudgetNotice) {
      deps.setRunBudgetNotice(event.evidence);
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
