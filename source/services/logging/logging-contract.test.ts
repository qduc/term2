import { it, expect } from 'vitest';
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

it('buildRuntimeLogRecord produces canonical required fields', () => {
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
  expect(parsed.traceId).toBe('trace-123');
  expect(parsed.eventType).toBe('stream.started');
  expect(parsed.traceId).toBe('trace-123');
  expect('category' in record).toBe(false);
  expect('phase' in record).toBe(false);
});

it('buildRuntimeLogRecord omits sentinel-valued fields', () => {
  const record = buildRuntimeLogRecord({
    level: 'warn',
    meta: {
      eventType: 'log.message',
      messageId: 'msg-1',
    },
  });

  expect('provider' in record).toBe(false);
  expect('model' in record).toBe(false);
  expect('sessionId' in record).toBe(false);
  expect('traceId' in record).toBe(false);
  expect('category' in record).toBe(false);
  expect('phase' in record).toBe(false);
  const parsed = RuntimeLogSchema.parse(record);
  expect(parsed.eventType).toBe('log.message');
});

it('buildRuntimeLogRecord preserves valid provider/model/session/trace', () => {
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

  expect(record.provider).toBe('openai');
  expect(record.model).toBe('gpt-5');
  expect(record.sessionId).toBe('abc-123');
  expect(record.traceId).toBe('550e8400-e29b-41d4-a716-446655440000');
});

it('parseCategoryFilter parses valid comma-separated categories', () => {
  const parsed = parseCategoryFilter('retry, tool,invalid');
  expect(parsed).toBeTruthy();
  expect(parsed?.has('retry')).toBe(true);
  expect(parsed?.has('tool')).toBe(true);
  expect(parsed?.has('provider')).toBe(false);
});

it('shouldLogForCategory always keeps warn/error logs', () => {
  const enabled = new Set(['tool'] as const);
  expect(shouldLogForCategory({ level: 'warn', category: 'stream', enabledCategories: enabled as any })).toBe(true);
  expect(shouldLogForCategory({ level: 'error', category: 'stream', enabledCategories: enabled as any })).toBe(true);
  expect(shouldLogForCategory({ level: 'info', category: 'stream', enabledCategories: enabled as any })).toBe(false);
});

it('shouldIncludeVerbosePayload keeps payload only for error unless verbose', () => {
  expect(shouldIncludeVerbosePayload({ level: 'info', verbosePayloads: false })).toBe(false);
  expect(shouldIncludeVerbosePayload({ level: 'error', verbosePayloads: false })).toBe(true);
  expect(shouldIncludeVerbosePayload({ level: 'info', verbosePayloads: true })).toBe(true);
});

it('shouldSampleLog respects sample rate but never drops errors', () => {
  expect(shouldSampleLog({ level: 'debug', sampleRate: 0.2, randomValue: 0.9 })).toBe(false);
  expect(shouldSampleLog({ level: 'debug', sampleRate: 0.2, randomValue: 0.1 })).toBe(true);
  expect(shouldSampleLog({ level: 'error', sampleRate: 0, randomValue: 0.99 })).toBe(true);
});

it('resolveLogCategory infers category from event type prefix', () => {
  expect(resolveLogCategory({ eventType: 'retry.hallucination' })).toBe('retry');
  expect(resolveLogCategory({ eventType: 'tool_call.validation_failed' })).toBe('tool');
  expect(resolveLogCategory({ eventType: 'approval.required' })).toBe('approval');
  expect(resolveLogCategory({ eventType: 'something.else' })).toBe('general');
});

it('createInvalidToolCallDiagnostic returns a complete packet', () => {
  const diagnostic = createInvalidToolCallDiagnostic({
    toolName: 'shell',
    toolCallId: 'call-7',
    rawPayload: '{"command":',
    normalizedToolCall: { toolName: 'shell', toolCallId: 'call-7' },
    validationErrors: ['arguments must be valid JSON'],
    traceId: 'trace-1',
    retryContext: { hallucinationRetryCount: 1 },
  });

  expect(diagnostic.eventType).toBe('tool_call.parse_failed');
  expect(diagnostic.errorCode).toBe('INVALID_TOOL_CALL_FORMAT');
  expect(diagnostic.validationErrors).toEqual(['arguments must be valid JSON']);
  expect(typeof diagnostic.rawPayloadSnippet === 'string').toBe(true);
});
