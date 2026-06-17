import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createStreamingSession } from './streaming-session-factory.js';

it('createStreamingSession wires state and logs final usage', () => {
  const calls: {
    eventHandlerEvents: any[];
    debugMessages: Array<{ message: string; meta?: any }>;
    lastUsage?: any;
    eventHandlerDeps?: any;
    eventHandlerState?: any;
    streamingState?: any;
  } = {
    eventHandlerEvents: [],
    debugMessages: [],
  };

  const reasoningUpdater = { push: () => {}, cancel: () => {}, flush: () => {} };
  const usage = { total_tokens: 12 };

  const session = createStreamingSession(
    {
      appendMessages: () => {},
      setMessages: () => {},
      trimMessages: (messages) => messages,
      annotateCommandMessage: (msg) => msg,
      loggingService: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: (message, meta) => calls.debugMessages.push({ message, meta }),
        security: () => {},
        setCorrelationId: () => {},
        getCorrelationId: () => undefined,
        clearCorrelationId: () => {},
      },
      setLastUsage: (nextUsage) => {
        calls.lastUsage = nextUsage;
      },
      reasoningThrottleMs: 200,
      now: () => 123,
      createStreamingState: () => {
        const state = {
          accumulatedText: '',
          flushedTextLength: 0,
          currentBotMessageId: null,
          accumulatedReasoningText: '',
          flushedReasoningLength: 0,
          textWasFlushed: false,
          currentReasoningMessageId: null,
          latestUsage: null,
        };
        calls.streamingState = state;
        return state;
      },
      createStreamingUpdateCoordinator: (_callback) => {
        return reasoningUpdater;
      },
      createConversationEventHandler: (deps, state) => {
        calls.eventHandlerDeps = deps;
        calls.eventHandlerState = state;
        return (event) => calls.eventHandlerEvents.push(event);
      },
    },
    'sendUserMessage',
  );

  expect(calls.eventHandlerState).toBe(calls.streamingState);

  const finalEvent = { type: 'final', usage, finalText: '' } as const;
  session.applyConversationEvent(finalEvent);

  expect(calls.lastUsage).toBe(usage);
  expect(session.streamingState.latestUsage).toBe(usage);
  expect(calls.debugMessages[0]?.message).toBe('UI received final usage (sendUserMessage)');
  expect(calls.debugMessages[0]?.meta).toEqual({ usage });
  expect(calls.eventHandlerEvents).toEqual([finalEvent]);

  session.applyConversationEvent({ type: 'final', finalText: '' } as const);
  expect(calls.debugMessages[1]?.message).toBe('UI final event has no usage (sendUserMessage)');
});

it('final event does not overwrite the per-turn footer usage with the run-cumulative total', () => {
  const calls: { lastUsageHistory: any[]; debugMessages: string[] } = {
    lastUsageHistory: [],
    debugMessages: [],
  };

  const reasoningUpdater = { push: () => {}, cancel: () => {}, flush: () => {} };

  const session = createStreamingSession(
    {
      appendMessages: () => {},
      setMessages: () => {},
      trimMessages: (messages) => messages,
      annotateCommandMessage: (msg) => msg,
      loggingService: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: (message) => calls.debugMessages.push(message),
        security: () => {},
        setCorrelationId: () => {},
        getCorrelationId: () => undefined,
        clearCorrelationId: () => {},
      },
      setLastUsage: (nextUsage) => {
        calls.lastUsageHistory.push(nextUsage);
      },
      reasoningThrottleMs: 200,
      now: () => 123,
      createStreamingUpdateCoordinator: () => reasoningUpdater,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  // Per-turn streamed usage for the last model turn (what the footer should show).
  const lastTurnUsage = { prompt_tokens: 1800, completion_tokens: 90, total_tokens: 1890 };
  session.applyConversationEvent({ type: 'usage_update', usage: lastTurnUsage } as const);

  // Terminal final event carries the run-cumulative total (sum of every turn).
  const runTotalUsage = { prompt_tokens: 9000, completion_tokens: 420, total_tokens: 9420 };
  session.applyConversationEvent({ type: 'final', finalText: 'Done.', usage: runTotalUsage } as const);

  // Footer keeps the last per-turn value; it is not overwritten by the run total.
  expect(session.streamingState.latestUsage).toBe(lastTurnUsage);
  expect(calls.lastUsageHistory).toEqual([lastTurnUsage]);
  expect(calls.debugMessages.some((m) => m.startsWith('UI keeping last streamed turn usage'))).toBe(true);
});

it('botResponseUpdater creates and updates streaming bot messages', () => {
  let messages: any[] = [];

  const session = createStreamingSession(
    {
      appendMessages: (additions) => {
        messages = [...messages, ...additions];
      },
      setMessages: (updater) => {
        messages = updater(messages);
      },
      trimMessages: (nextMessages) => nextMessages,
      annotateCommandMessage: (msg) => msg,
      loggingService: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        security: () => {},
        setCorrelationId: () => {},
        getCorrelationId: () => undefined,
        clearCorrelationId: () => {},
      },
      setLastUsage: () => {},
      reasoningThrottleMs: 200,
      now: () => 456,
      createStreamingUpdateCoordinator: (callback) => {
        const invoke = callback as unknown as (...args: any[]) => void;
        return {
          push: (...args: any[]) => invoke(...args),
          flush: () => {},
          cancel: () => {},
        };
      },
    },
    'sendUserMessage',
  );

  session.botResponseUpdater.push('Partial');
  session.botResponseUpdater.push('Partial response');

  expect(messages).toEqual([
    {
      id: '456-0',
      sender: 'bot',
      status: 'streaming',
      text: 'Partial response',
    },
  ]);
});
