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

function attachSettledSpeed(usage: NormalizedUsage, tracker: StreamingSpeedTracker, now: number): void {
  const settled = tracker.getSettledTps({
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.reasoning_tokens,
    completionMs: usage.completion_ms,
    endTime: now,
  });
  if (settled) {
    usage.tokens_per_second = settled.tps;
    if (settled.approximate) usage.tokens_per_second_estimated = true;
    else delete usage.tokens_per_second_estimated;
    // Burst-inflated decode rate: pair it with its coverage fraction (decode
    // window ÷ turn wall-clock). Wall-clock is TTFT + decode window, both
    // measured from request start by the same tracker clock. Without TTFT
    // there is no wall to cover, so the window is dropped rather than shown
    // against nothing.
    const ttftMs = tracker.getTtftMs();
    if (settled.decodeWindowMs != null && ttftMs != null && ttftMs > 0) {
      usage.tokens_per_second_coverage = settled.decodeWindowMs / (ttftMs + settled.decodeWindowMs);
    } else {
      delete usage.tokens_per_second_coverage;
    }
  }
  const ttftMs = tracker.getTtftMs();
  if (ttftMs != null) {
    usage.ttft_ms = ttftMs;
  }
}

export interface StreamingSessionFactoryDeps {
  appendMessages: ConversationEventHandlerDeps['appendMessages'];
  setMessages: ConversationEventHandlerDeps['setMessages'];
  trimMessages: ConversationEventHandlerDeps['trimMessages'];
  annotateCommandMessage: ConversationEventHandlerDeps['annotateCommandMessage'];
  loggingService: ILoggingService;
  setLastUsage: (usage: NormalizedUsage) => void;
  setCodexRateLimit?: (rateLimit: CodexRateLimitInfo) => void;
  setStreamingSpeed?: (speed: { tps: number; ttftMs?: number } | null) => void;
  /** Seed for live char/token estimates; typically the last calibrated ratio for this conversation. */
  charsPerToken?: number;
  onCharsPerTokenCalibrated?: (charsPerToken: number) => void;
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

  const speedTracker = new StreamingSpeedTracker({ startTime: now(), charsPerToken: deps.charsPerToken });

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
    } else if (event.type === 'tool_dispatched') {
      // Tool execution isn't token generation and belongs to a separate model request than
      // whatever comes next; reset so the next request's speed is measured from zero instead of
      // being diluted by tool latency or averaged together with this request.
      speedTracker.reset(now());
    } else if (event.type === 'usage_update') {
      if (event.usage.completion_tokens) {
        speedTracker.recordUsageTokens(event.usage.completion_tokens, now());
        deps.onCharsPerTokenCalibrated?.(speedTracker.getCharsPerToken());
      }
      notifySpeed();
      attachSettledSpeed(event.usage, speedTracker, now());
      deps.loggingService.debug(`UI received streaming usage (${label})`, { usage: event.usage });
      streamingState.latestUsage = event.usage;
      deps.setLastUsage(event.usage);
    } else if (event.type === 'final') {
      deps.setStreamingSpeed?.(null);

      if (event.usage && !streamingState.latestUsage) {
        // No usage_update happened during this turn (e.g. a single non-tool-call request), so
        // this is the only chance to compute settled TPS for it.
        attachSettledSpeed(event.usage, speedTracker, now());
        deps.loggingService.debug(`UI received final usage (${label})`, { usage: event.usage });
        streamingState.latestUsage = event.usage;
        deps.setLastUsage(event.usage);
      } else if (event.usage) {
        // A usage_update already computed the correct per-request TPS for the last request in
        // this turn (before the tracker was reset for tool execution / subsequent requests).
        // final's usage is the run-cumulative total, not a fresh generation to measure — leave
        // the already-settled per-request value on streamingState.latestUsage untouched.
        deps.loggingService.debug(`UI keeping last streamed turn usage; final carries run total (${label})`, {
          finalUsage: event.usage,
          shownUsage: streamingState.latestUsage,
        });
      } else {
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
