import test from 'ava';
import { createStreamingSession } from './streaming-session-factory.js';

test('createStreamingSession wires state and logs final usage', (t) => {
  const calls: {
    liveResponses: any[];
    liveResponseIds: number[];
    coordinatorInterval?: number;
    eventHandlerEvents: any[];
    debugMessages: Array<{ message: string; meta?: any }>;
    lastUsage?: any;
    eventHandlerDeps?: any;
    eventHandlerState?: any;
    streamingState?: any;
  } = {
    liveResponses: [],
    liveResponseIds: [],
    eventHandlerEvents: [],
    debugMessages: [],
  };

  const liveResponseUpdater = { push: () => {}, cancel: () => {}, flush: () => {} };
  const reasoningUpdater = { push: () => {}, cancel: () => {}, flush: () => {} };
  const usage = { total_tokens: 12 };

  const session = createStreamingSession(
    {
      appendMessages: () => {},
      setMessages: () => {},
      setLiveResponse: (response) => calls.liveResponses.push(response),
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
      createLiveResponseUpdater: (id) => {
        calls.liveResponseIds.push(id);
        return liveResponseUpdater;
      },
      reasoningThrottleMs: 200,
      now: () => 123,
      createStreamingState: () => {
        const state = {
          accumulatedText: '',
          accumulatedReasoningText: '',
          flushedReasoningLength: 0,
          textWasFlushed: false,
          currentReasoningMessageId: null,
        };
        calls.streamingState = state;
        return state;
      },
      createStreamingUpdateCoordinator: (_callback, interval) => {
        calls.coordinatorInterval = interval;
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

  t.deepEqual(calls.liveResponses, [{ id: 123, sender: 'bot', text: '' }]);
  t.deepEqual(calls.liveResponseIds, [123]);
  t.is(calls.coordinatorInterval, 200);
  t.is(calls.eventHandlerState, calls.streamingState);
  t.is(calls.eventHandlerDeps.liveResponseUpdater, liveResponseUpdater);
  t.is(calls.eventHandlerDeps.reasoningUpdater, reasoningUpdater);

  const finalEvent = { type: 'final', usage, finalText: '' } as const;
  session.applyConversationEvent(finalEvent);

  t.is(calls.lastUsage, usage);
  t.is(calls.debugMessages[0]?.message, 'UI received final usage (sendUserMessage)');
  t.deepEqual(calls.debugMessages[0]?.meta, { usage });
  t.deepEqual(calls.eventHandlerEvents, [finalEvent]);

  session.applyConversationEvent({ type: 'final', finalText: '' } as const);
  t.is(calls.debugMessages[1]?.message, 'UI final event has no usage (sendUserMessage)');
});
