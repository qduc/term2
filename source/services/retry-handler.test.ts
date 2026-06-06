import test from 'ava';
import { ModelBehaviorError } from '@openai/agents';
import { APIConnectionTimeoutError } from 'openai';
import { ChainingTransportDowngradeError } from '../providers/fallback-responses-model.js';
import { ConversationStore } from './conversation-store.js';
import { RetryHandler } from './retry-handler.js';
import { ToolExecutionLedger } from './tool-execution-ledger.js';

const makeHandler = (agentClient: Record<string, any> = {}) =>
  new RetryHandler(
    {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      security: () => undefined,
      setCorrelationId: () => undefined,
      getCorrelationId: () => 'trace-1',
      clearCorrelationId: () => undefined,
    },
    'session-1',
    agentClient as any,
  );

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

test('classifyError returns flex fallback when available', (t) => {
  const handler = makeHandler({ shouldRetryWithoutFlexServiceTier: () => true });

  const decision = handler.classifyError({
    error: new Error('flex timeout'),
    transientRetryCount: 0,
    transportFallbackRetryCount: 0,
    hallucinationRetryCount: 0,
    flexServiceTierFallbackCount: 0,
    maxTransientRetries: 5,
    stream: null,
    streamHistoryLength: 0,
  });

  t.deepEqual(decision, { kind: 'flex_fallback' });
});

test('classifyError returns transient retry for retryable upstream errors', (t) => {
  const handler = makeHandler();

  const decision = handler.classifyError({
    error: asInstanceOf<APIConnectionTimeoutError>(APIConnectionTimeoutError.prototype, { message: 'timeout' }),
    transientRetryCount: 1,
    transportFallbackRetryCount: 0,
    hallucinationRetryCount: 0,
    flexServiceTierFallbackCount: 0,
    maxTransientRetries: 5,
    stream: null,
    streamHistoryLength: 0,
  });

  t.is(decision.kind, 'transient');
  if (decision.kind !== 'transient') return;
  t.is(decision.attempt, 2);
  t.true(decision.delay >= 800);
  t.true(decision.delay <= 1200);
});

test('classifyError returns transport downgrade when forced', (t) => {
  const handler = makeHandler({
    forceTransportDowngrade: () => true,
  });

  const decision = handler.classifyError({
    error: new ChainingTransportDowngradeError('ws failed'),
    transientRetryCount: 5,
    transportFallbackRetryCount: 0,
    hallucinationRetryCount: 0,
    flexServiceTierFallbackCount: 0,
    maxTransientRetries: 5,
    stream: null,
    streamHistoryLength: 0,
  });

  t.deepEqual(decision, { kind: 'transport_downgrade' });
});

test('classifyError returns hallucination retry when the model error is recoverable', (t) => {
  const handler = makeHandler();

  const decision = handler.classifyError({
    error: new ModelBehaviorError('Tool fake_tool not found'),
    transientRetryCount: 0,
    transportFallbackRetryCount: 0,
    hallucinationRetryCount: 0,
    flexServiceTierFallbackCount: 0,
    maxTransientRetries: 5,
    stream: { completed: Promise.resolve(undefined) } as any,
    streamHistoryLength: 4,
  });

  t.is(decision.kind, 'hallucination');
  if (decision.kind !== 'hallucination') return;
  t.is(decision.decision.kind, 'retry');
  if (decision.decision.kind !== 'retry') return;
  t.is(decision.decision.retryEvent.toolName, 'fake_tool');
});

test('classifyError returns unrecoverable when retry limits are exhausted or error is not retryable', (t) => {
  const retryingHandler = makeHandler({
    shouldRetryWithoutFlexServiceTier: () => true,
    forceTransportDowngrade: () => true,
  });

  const exhausted = retryingHandler.classifyError({
    error: new ModelBehaviorError('Tool fake_tool not found'),
    transientRetryCount: 5,
    transportFallbackRetryCount: 1,
    hallucinationRetryCount: 2,
    flexServiceTierFallbackCount: 1,
    maxTransientRetries: 5,
    stream: null,
    streamHistoryLength: 0,
  });
  t.deepEqual(exhausted, { kind: 'unrecoverable' });

  const genericHandler = makeHandler();
  const generic = genericHandler.classifyError({
    error: new Error('boom'),
    transientRetryCount: 0,
    transportFallbackRetryCount: 0,
    hallucinationRetryCount: 0,
    flexServiceTierFallbackCount: 0,
    maxTransientRetries: 5,
    stream: null,
    streamHistoryLength: 0,
  });
  t.deepEqual(generic, { kind: 'unrecoverable' });
});

test.serial('getTransientDelay uses exponential backoff with jitter', (t) => {
  const handler = makeHandler();
  const originalRandom = Math.random;
  t.teardown(() => {
    Math.random = originalRandom;
  });

  Math.random = () => 0;
  t.is(handler.getTransientDelay(1), 450);

  Math.random = () => 1;
  t.is(handler.getTransientDelay(3), 2200);
});

test('restoreForRetry restores completed tool entries and reconciles history', (t) => {
  const handler = makeHandler();
  const ledger = new ToolExecutionLedger();
  ledger.import([
    {
      turnId: 'turn-1',
      callId: 'call-read',
      toolName: 'read_file',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      historyItems: [
        { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
        { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', output: 'contents' },
      ],
    },
  ]);

  const conversationStore = new ConversationStore();
  conversationStore.addUserMessage('retry me');

  let previousResponseIdCleared = 0;

  handler.restoreForRetry({
    ledgerSnapshot: [],
    stream: { completed: Promise.resolve(undefined) } as any,
    toolLedger: ledger,
    conversationStore,
    clearPreviousResponseId: () => {
      previousResponseIdCleared++;
    },
    restoreCompletedToolLedgerEntries: (snapshot) => ledger.import([...snapshot, ...ledger.export()]),
  });

  t.is(previousResponseIdCleared, 1);
  t.is(ledger.export().length, 1);
  t.is(conversationStore.getHistory().length, 3);
  t.is((conversationStore.getHistory()[1] as any).callId, 'call-read');
  t.is((conversationStore.getHistory()[2] as any).callId, 'call-read');
});

test('restoreForRetry removes the last user message when there is no stream', (t) => {
  const handler = makeHandler();
  const ledger = new ToolExecutionLedger();
  const conversationStore = new ConversationStore();
  conversationStore.addUserMessage('retry me');

  let removed = 0;

  handler.restoreForRetry({
    ledgerSnapshot: [],
    stream: null,
    toolLedger: ledger,
    conversationStore,
    clearPreviousResponseId: () => undefined,
    restoreCompletedToolLedgerEntries: (snapshot) => ledger.import(snapshot),
    removeLastUserMessage: () => {
      removed++;
      conversationStore.removeLastUserMessage();
    },
  });

  t.is(removed, 1);
  t.is(conversationStore.getHistory().length, 0);
});
