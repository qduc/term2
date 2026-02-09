import test from 'ava';
import {
  RuntimeLogSchema,
  buildRuntimeLogRecord,
  createInvalidToolCallDiagnostic,
  parseCategoryFilter,
  resolveLogCategory,
  shouldIncludeVerbosePayload,
  shouldLogForCategory,
  shouldSampleLog,
} from './logging-contract.js';

test('buildRuntimeLogRecord produces canonical required fields', (t) => {
  const record = buildRuntimeLogRecord({
    level: 'info',
    correlationId: 'trace-123',
    meta: {
      eventType: 'stream.started',
      phase: 'request_start',
      sessionId: 'session-1',
      provider: 'openai',
      model: 'gpt-5',
      messageId: 'msg-1',
    },
  });

  const parsed = RuntimeLogSchema.parse(record);
  t.is(parsed.traceId, 'trace-123');
  t.is(parsed.eventType, 'stream.started');
  t.is(parsed.phase, 'request_start');
  t.is(parsed.category, 'stream');
});

test('parseCategoryFilter parses valid comma-separated categories', (t) => {
  const parsed = parseCategoryFilter('retry, tool,invalid');
  t.truthy(parsed);
  t.true(parsed?.has('retry'));
  t.true(parsed?.has('tool'));
  t.false(parsed?.has('provider'));
});

test('shouldLogForCategory always keeps warn/error logs', (t) => {
  const enabled = new Set(['tool'] as const);
  t.true(shouldLogForCategory({ level: 'warn', category: 'stream', enabledCategories: enabled as any }));
  t.true(shouldLogForCategory({ level: 'error', category: 'stream', enabledCategories: enabled as any }));
  t.false(shouldLogForCategory({ level: 'info', category: 'stream', enabledCategories: enabled as any }));
});

test('shouldIncludeVerbosePayload keeps payload only for error unless verbose', (t) => {
  t.false(shouldIncludeVerbosePayload({ level: 'info', verbosePayloads: false }));
  t.true(shouldIncludeVerbosePayload({ level: 'error', verbosePayloads: false }));
  t.true(shouldIncludeVerbosePayload({ level: 'info', verbosePayloads: true }));
});

test('shouldSampleLog respects sample rate but never drops errors', (t) => {
  t.false(shouldSampleLog({ level: 'debug', sampleRate: 0.2, randomValue: 0.9 }));
  t.true(shouldSampleLog({ level: 'debug', sampleRate: 0.2, randomValue: 0.1 }));
  t.true(shouldSampleLog({ level: 'error', sampleRate: 0, randomValue: 0.99 }));
});

test('resolveLogCategory infers category from event type prefix', (t) => {
  t.is(resolveLogCategory({ eventType: 'retry.hallucination' }), 'retry');
  t.is(resolveLogCategory({ eventType: 'tool_call.validation_failed' }), 'tool');
  t.is(resolveLogCategory({ eventType: 'approval.required' }), 'approval');
  t.is(resolveLogCategory({ eventType: 'something.else' }), 'general');
});

test('createInvalidToolCallDiagnostic returns a complete packet', (t) => {
  const diagnostic = createInvalidToolCallDiagnostic({
    toolName: 'shell',
    toolCallId: 'call-7',
    rawPayload: '{"command":',
    normalizedToolCall: { toolName: 'shell', toolCallId: 'call-7' },
    validationErrors: ['arguments must be valid JSON'],
    traceId: 'trace-1',
    retryContext: { hallucinationRetryCount: 1 },
  });

  t.is(diagnostic.eventType, 'tool_call.parse_failed');
  t.is(diagnostic.errorCode, 'INVALID_TOOL_CALL_FORMAT');
  t.deepEqual(diagnostic.validationErrors, ['arguments must be valid JSON']);
  t.true(typeof diagnostic.rawPayloadSnippet === 'string');
});
