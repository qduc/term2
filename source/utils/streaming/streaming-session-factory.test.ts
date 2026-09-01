import { it, expect } from 'vitest';
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
          contextCompactionMessageId: null,
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

it('reports live streaming speed and attaches settled TPS on final event', () => {
  const speedReports: any[] = [];
  let lastUsage: any = null;
  let currentTime = 1000;

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
        debug: () => {},
        security: () => {},
        setCorrelationId: () => {},
        getCorrelationId: () => undefined,
        clearCorrelationId: () => {},
      },
      setLastUsage: (usage) => {
        lastUsage = usage;
      },
      setStreamingSpeed: (speed) => {
        speedReports.push(speed);
      },
      reasoningThrottleMs: 200,
      now: () => currentTime,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  // First token delta at 1200ms
  currentTime = 1200;
  session.applyConversationEvent({ type: 'text_delta', delta: 'Hello ', fullText: 'Hello ' } as const);

  // Second delta at 2200ms (1000ms after first token, ~190 chars ≈ 50 tokens -> 50 tok/s)
  currentTime = 2200;
  session.applyConversationEvent({
    type: 'text_delta',
    delta: 'a'.repeat(184),
    fullText: 'Hello ' + 'a'.repeat(184),
  } as const);

  expect(speedReports.length).toBeGreaterThan(0);
  const latestReport = speedReports[speedReports.length - 1];
  expect(latestReport).toEqual({
    tps: expect.any(Number),
    ttftMs: 200,
  });

  // Final event at 3200ms (2.0s generation duration, 100 completion tokens -> 50.0 tok/s)
  currentTime = 3200;
  session.applyConversationEvent({
    type: 'final',
    finalText: 'Done',
    usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
  } as const);

  // Speed report reset on final
  expect(speedReports[speedReports.length - 1]).toBeNull();
  // Final usage contains settled TPS
  expect(lastUsage?.tokens_per_second).toBe(50);
  expect(lastUsage?.ttft_ms).toBe(200);
});

it('tracks speed during tool_call_streaming_delta without error', () => {
  const speedReports: any[] = [];
  let currentTime = 1000;

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
        debug: () => {},
        security: () => {},
        setCorrelationId: () => {},
        getCorrelationId: () => undefined,
        clearCorrelationId: () => {},
      },
      setLastUsage: () => {},
      setStreamingSpeed: (speed) => {
        speedReports.push(speed);
      },
      reasoningThrottleMs: 200,
      now: () => currentTime,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  // Tool delta at 1200ms
  currentTime = 1200;
  expect(() => {
    session.applyConversationEvent({
      type: 'tool_call_streaming_delta',
      toolName: 'read_file',
      argumentCharCount: 50,
    } as const);
  }).not.toThrow();

  // Tool delta at 2200ms
  currentTime = 2200;
  expect(() => {
    session.applyConversationEvent({
      type: 'tool_call_streaming_delta',
      toolName: 'read_file',
      argumentCharCount: 200,
    } as const);
  }).not.toThrow();

  expect(speedReports.length).toBeGreaterThan(0);
});

it('measures each request in a turn separately, resetting at tool_dispatched', () => {
  const lastUsageHistory: any[] = [];
  let currentTime = 0;

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
        debug: () => {},
        security: () => {},
        setCorrelationId: () => {},
        getCorrelationId: () => undefined,
        clearCorrelationId: () => {},
      },
      setLastUsage: (usage) => {
        lastUsageHistory.push(usage);
      },
      setStreamingSpeed: () => {},
      reasoningThrottleMs: 200,
      now: () => currentTime,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  // First model request: streams 10 tokens over 1s (t=0 -> t=1000), then its own usage_update
  // (per-request completion_tokens=10) arrives before the tool it called is dispatched.
  currentTime = 0;
  session.applyConversationEvent({ type: 'text_delta', delta: 'a'.repeat(4), fullText: 'a' } as const);
  currentTime = 1000;
  session.applyConversationEvent({ type: 'text_delta', delta: 'a'.repeat(36), fullText: 'aa' } as const);
  session.applyConversationEvent({
    type: 'usage_update',
    usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
  } as const);
  const firstRequestUsage = lastUsageHistory[lastUsageHistory.length - 1];
  expect(firstRequestUsage.tokens_per_second).toBe(10); // 10 tok / 1s

  // Tool executes for 5s: t=1000 -> t=6000. This resets the tracker for the next request.
  session.applyConversationEvent({
    type: 'tool_dispatched',
    toolCallId: 'call-1',
    toolName: 'bash',
  } as const);

  // Second model request resumes after the tool: 20 tokens over 1s (t=6000 -> t=7000), measured
  // from zero — not diluted by the 5s tool gap or averaged with the first request's 10 tok/s.
  currentTime = 6000;
  session.applyConversationEvent({ type: 'text_delta', delta: 'b'.repeat(4), fullText: 'ab' } as const);
  currentTime = 7000;
  session.applyConversationEvent({ type: 'text_delta', delta: 'b'.repeat(76), fullText: 'abb' } as const);
  session.applyConversationEvent({
    type: 'usage_update',
    usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
  } as const);
  const secondRequestUsage = lastUsageHistory[lastUsageHistory.length - 1];
  expect(secondRequestUsage.tokens_per_second).toBe(20); // 20 tok / 1s, not 30 tok / 7s

  // Turn ends: final carries the run-cumulative total. It must not overwrite the second
  // request's already-correct settled TPS with a value derived from the cumulative token count.
  session.applyConversationEvent({
    type: 'final',
    finalText: 'abb',
    usage: { prompt_tokens: 25, completion_tokens: 30, total_tokens: 55 },
  } as const);

  expect(secondRequestUsage.tokens_per_second).toBe(20);
});

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
  };
}

it('prefers provider completion_ms when settling usage_update TPS', () => {
  let lastUsage: any = null;
  let currentTime = 1000;
  const session = createStreamingSession(
    {
      appendMessages: () => {},
      setMessages: () => {},
      trimMessages: (messages) => messages,
      annotateCommandMessage: (msg) => msg,
      loggingService: silentLogger(),
      setLastUsage: (usage) => {
        lastUsage = usage;
      },
      reasoningThrottleMs: 200,
      now: () => currentTime,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  currentTime = 1200;
  session.applyConversationEvent({ type: 'text_delta', delta: 'Hello', fullText: 'Hello' } as const);
  currentTime = 3200;
  session.applyConversationEvent({
    type: 'usage_update',
    usage: { prompt_tokens: 10, completion_tokens: 100, completion_ms: 1000, total_tokens: 110 },
  } as const);

  // Wall-clock from first token would be 2s -> 50 tok/s. Provider decode time is 1s.
  expect(lastUsage?.tokens_per_second).toBe(100);
  expect(lastUsage?.tokens_per_second_estimated).toBeUndefined();
});

it('does not attach TPS on a usage event with no visible tokens and no completion_ms', () => {
  let lastUsage: any = null;
  const session = createStreamingSession(
    {
      appendMessages: () => {},
      setMessages: () => {},
      trimMessages: (messages) => messages,
      annotateCommandMessage: (msg) => msg,
      loggingService: silentLogger(),
      setLastUsage: (usage) => {
        lastUsage = usage;
      },
      reasoningThrottleMs: 200,
      now: () => 3000,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  session.applyConversationEvent({
    type: 'usage_update',
    usage: { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 },
  } as const);

  expect(lastUsage?.tokens_per_second).toBeUndefined();
});

it('subtracts reasoning_tokens when settling TPS', () => {
  let lastUsage: any = null;
  let currentTime = 0;
  const session = createStreamingSession(
    {
      appendMessages: () => {},
      setMessages: () => {},
      trimMessages: (messages) => messages,
      annotateCommandMessage: (msg) => msg,
      loggingService: silentLogger(),
      setLastUsage: (usage) => {
        lastUsage = usage;
      },
      reasoningThrottleMs: 200,
      now: () => currentTime,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  session.applyConversationEvent({ type: 'text_delta', delta: 'visible', fullText: 'visible' } as const);
  currentTime = 1000;
  session.applyConversationEvent({
    type: 'usage_update',
    usage: { completion_tokens: 100, reasoning_tokens: 80 },
  } as const);

  expect(lastUsage?.tokens_per_second).toBe(20);
  expect(lastUsage?.tokens_per_second_estimated).toBeUndefined();
});

it('marks settled TPS estimated when hidden tokens inflate the numerator', () => {
  let lastUsage: any = null;
  let currentTime = 0;
  const session = createStreamingSession(
    {
      appendMessages: () => {},
      setMessages: () => {},
      trimMessages: (messages) => messages,
      annotateCommandMessage: (msg) => msg,
      loggingService: silentLogger(),
      setLastUsage: (usage) => {
        lastUsage = usage;
      },
      reasoningThrottleMs: 200,
      now: () => currentTime,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  session.applyConversationEvent({ type: 'text_delta', delta: 'a'.repeat(40), fullText: 'a'.repeat(40) } as const);
  currentTime = 1000;
  session.applyConversationEvent({
    type: 'usage_update',
    usage: { completion_tokens: 100 },
  } as const);

  expect(lastUsage?.tokens_per_second).toBe(100);
  expect(lastUsage?.tokens_per_second_estimated).toBe(true);
});

it('seeds live estimates from the conversation chars-per-token ratio and reports recalibration', () => {
  const calibrated: number[] = [];
  const liveTps: number[] = [];
  let currentTime = 0;
  const session = createStreamingSession(
    {
      appendMessages: () => {},
      setMessages: () => {},
      trimMessages: (messages) => messages,
      annotateCommandMessage: (msg) => msg,
      loggingService: silentLogger(),
      setLastUsage: () => {},
      setStreamingSpeed: (speed) => {
        if (speed) liveTps.push(speed.tps);
      },
      charsPerToken: 4,
      onCharsPerTokenCalibrated: (ratio) => calibrated.push(ratio),
      reasoningThrottleMs: 200,
      now: () => currentTime,
      createConversationEventHandler: () => () => {},
    },
    'sendUserMessage',
  );

  currentTime = 0;
  session.applyConversationEvent({ type: 'text_delta', delta: 'a'.repeat(200), fullText: 'a'.repeat(200) } as const);
  currentTime = 1000;
  session.applyConversationEvent({ type: 'text_delta', delta: 'x', fullText: 'a'.repeat(200) + 'x' } as const);
  // Seeded at 4 chars/token: ~50 tok/s, not the default 3.8 (~53 tok/s).
  expect(liveTps.at(-1)).toBe(50);

  session.applyConversationEvent({
    type: 'usage_update',
    usage: { completion_tokens: 20 },
  } as const);

  expect(calibrated[0]).toBe(10);
});
