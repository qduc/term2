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
      sessionId: 'session-1',
      provider: 'openai',
      model: 'gpt-5',
      messageId: 'msg-1',
    },
  });

  const parsed = RuntimeLogSchema.parse(record);
  t.is(parsed.traceId, 'trace-123');
  t.is(parsed.eventType, 'stream.started');
  t.is(parsed.traceId, 'trace-123');
  t.false('category' in record, 'category should be stripped');
  t.false('phase' in record, 'phase should be stripped');
});

test('buildRuntimeLogRecord omits sentinel-valued fields', (t) => {
  const record = buildRuntimeLogRecord({
    level: 'warn',
    meta: {
      eventType: 'log.message',
      messageId: 'msg-1',
    },
  });

  t.false('provider' in record, 'unknown provider omitted');
  t.false('model' in record, 'unknown model omitted');
  t.false('sessionId' in record, 'session-unknown omitted');
  t.false('traceId' in record, 'trace-unknown omitted');
  t.false('category' in record, 'category stripped');
  t.false('phase' in record, 'phase stripped');
  const parsed = RuntimeLogSchema.parse(record);
  t.is(parsed.eventType, 'log.message');
});

test('buildRuntimeLogRecord preserves valid provider/model/session/trace', (t) => {
  const record = buildRuntimeLogRecord({
    level: 'info',
    meta: {
      eventType: 'provider.response.failed',
      provider: 'openai',
      model: 'gpt-5',
      sessionId: 'abc-123',
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      messageId: 'msg-1',
    },
  });

  t.is(record.provider, 'openai');
  t.is(record.model, 'gpt-5');
  t.is(record.sessionId, 'abc-123');
  t.is(record.traceId, '550e8400-e29b-41d4-a716-446655440000');
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
