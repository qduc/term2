import { it, expect } from 'vitest';
import { createConversationEventHandler } from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import { createMockDeps } from './test-helpers/event-handler-fixtures.js';

const runOne = (event: ConversationEvent) => {
  const deps = createMockDeps();
  const handler = createConversationEventHandler(deps, createStreamingState());
  handler(event);
  expect(deps.calls.setMessagesCalls.length).toBe(1);
  return deps.calls.setMessagesCalls[0]!([]);
};

it('context_compaction_started: adds a system message announcing the compaction', () => {
  const result = runOne({
    type: 'context_compaction_started',
    provider: 'openai',
    sessionId: 's-1',
    inputTokensBefore: 128431,
  } as ConversationEvent);

  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('system');
  expect(result[0].text).toBe('Compacting context...');
});

it('context_compaction_completed: reports the pre-compaction prompt size', () => {
  const result = runOne({
    type: 'context_compaction_completed',
    provider: 'openai',
    sessionId: 's-1',
    inputTokensBefore: 128431,
    inputTokensAfter: undefined,
    durationMs: 0,
  } as ConversationEvent);

  expect(result[0].sender).toBe('system');
  expect(result[0].text).toBe('Compacted from 128,431 tokens.');
});

// durationMs is measured from a startedAt captured at the emit site, so it is always ~0.
// Rendering it would print a fabricated "(0.0s)"; assert it never reaches the transcript.
it('context_compaction_completed: omits the unmeasurable duration', () => {
  const result = runOne({
    type: 'context_compaction_completed',
    provider: 'openai',
    sessionId: 's-1',
    inputTokensBefore: 128431,
    durationMs: 0,
  } as ConversationEvent);

  expect(result[0].text).not.toMatch(/\ds\b|ms|0\.0/);
});

it('context_compaction_completed: falls back to a bare notice when no token count is available', () => {
  const result = runOne({
    type: 'context_compaction_completed',
    provider: 'openai',
    sessionId: 's-1',
    durationMs: 0,
  } as ConversationEvent);

  expect(result[0].text).toBe('Compacted context.');
});

it('context_compaction_failed: names the error category and omits the hardcoded duration', () => {
  const result = runOne({
    type: 'context_compaction_failed',
    provider: 'openai',
    sessionId: 's-1',
    errorCategory: 'validation',
    durationMs: 0,
  } as ConversationEvent);

  expect(result[0].sender).toBe('system');
  expect(result[0].text).toContain('validation');
  expect(result[0].text).not.toMatch(/\ds\b|ms|0\.0/);
});

// The bug this whole case set fixes: all three events previously fell through to
// `default:` and vanished, so compaction — including its failures — was invisible.
it('every context compaction event reaches the transcript', () => {
  const events: ConversationEvent[] = [
    { type: 'context_compaction_started', provider: 'openai', sessionId: 's-1' } as ConversationEvent,
    { type: 'context_compaction_completed', provider: 'openai', sessionId: 's-1', durationMs: 0 } as ConversationEvent,
    {
      type: 'context_compaction_failed',
      provider: 'openai',
      sessionId: 's-1',
      errorCategory: 'request',
      durationMs: 0,
    } as ConversationEvent,
  ];

  for (const event of events) {
    const result = runOne(event);
    expect(result.length, `${event.type} produced no message`).toBe(1);
  }
});
