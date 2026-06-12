// @ts-nocheck - Focused dependency-shape test with minimal collaborators
import test from 'ava';
import { ConversationAdapter } from './conversation-adapter.js';

const noop = () => {};

const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  setCorrelationId: noop,
  getCorrelationId: () => undefined,
  clearCorrelationId: noop,
};

const sessionContextService = {
  runWithContext: (_context, fn) => fn(),
  getContext: () => null,
};

test('ConversationAdapter delegates turn execution through an explicit turnFlow dependency', async (t) => {
  const calls = [];
  const turnFlow = {
    async *start(input, options) {
      calls.push({ method: 'start', input, options });
      yield { type: 'final', finalText: 'started' };
    },
    async *continueAfterApproval(options) {
      calls.push({ method: 'continueAfterApproval', options });
      yield { type: 'final', finalText: 'continued' };
    },
  };
  const approvalFlow = {
    getPending: () => ({ interruption: {}, token: 1 }),
    getPendingInterruption: () => ({}),
  };
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: '2026-06-12T00:00:00.000Z',
    logger,
    sessionContextService,
    conversationStore: {
      listUserTurns: () => [],
    },
    conversationLogger: {
      dispatchEventToLog: noop,
      log: noop,
    },
    approvalFlow,
    turnFlow,
  });

  const initial = await adapter.sendMessage('hello');
  const continued = await adapter.handleApprovalDecision('y');

  t.is(initial.finalText, 'started');
  t.is(continued?.finalText, 'continued');
  t.deepEqual(calls, [
    {
      method: 'start',
      input: 'hello',
      options: { retries: { hallucinationRetryCount: 0 } },
    },
    {
      method: 'continueAfterApproval',
      options: { answer: 'y', rejectionReason: undefined },
    },
  ]);
});
