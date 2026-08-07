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

it('context_compaction_completed: reports the measured duration alongside the token count', () => {
  const result = runOne({
    type: 'context_compaction_completed',
    provider: 'openai',
    sessionId: 's-1',
    inputTokensBefore: 8264,
    durationMs: 1376,
  } as ConversationEvent);

  expect(result[0].text).toBe('Compacted from 8,264 tokens (1.4s).');
});

// A zero duration means the provider gave no measurable interval (an unpaired frame, or a
// path with no frames at all). Printing "(0.0s)" would state a measurement that was not made.
it('context_compaction_completed: omits a zero duration rather than printing 0.0s', () => {
  const result = runOne({
    type: 'context_compaction_completed',
    provider: 'openai',
    sessionId: 's-1',
    inputTokensBefore: 128431,
    durationMs: 0,
  } as ConversationEvent);

  expect(result[0].text).toBe('Compacted from 128,431 tokens.');
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

// A response carries [compaction, message, compaction], so `started` fires twice per turn,
// but only the last compaction item becomes history. Two notices for one compaction would
// misreport what happened, so a later start supersedes the earlier one.
it('a second compaction start supersedes the first instead of stacking', () => {
  const deps = createMockDeps();
  const handler = createConversationEventHandler(deps, createStreamingState());

  handler({ type: 'context_compaction_started', provider: 'openai', sessionId: 's-1' } as ConversationEvent);
  handler({ type: 'context_compaction_started', provider: 'openai', sessionId: 's-1' } as ConversationEvent);
  handler({
    type: 'context_compaction_completed',
    provider: 'openai',
    sessionId: 's-1',
    inputTokensBefore: 8264,
    durationMs: 1376,
  } as ConversationEvent);

  // Fold the three updaters over a transcript that already holds an unrelated message.
  const existing: any[] = [{ id: 'other', sender: 'bot', status: 'finalized', text: 'hello' }];
  const messages = deps.calls.setMessagesCalls.reduce<any[]>((acc, updater) => updater(acc), existing);

  expect(messages.length).toBe(2);
  expect(messages[0].id).toBe('other');
  expect(messages[1].text).toBe('Compacted from 8,264 tokens (1.4s).');
});

it('the completion replaces the start notice in place rather than appending below it', () => {
  const deps = createMockDeps();
  const handler = createConversationEventHandler(deps, createStreamingState());

  handler({ type: 'context_compaction_started', provider: 'openai', sessionId: 's-1' } as ConversationEvent);
  const afterStart = deps.calls.setMessagesCalls[0]!([]);
  expect(afterStart.length).toBe(1);
  expect(afterStart[0].text).toBe('Compacting context...');

  handler({
    type: 'context_compaction_completed',
    provider: 'openai',
    sessionId: 's-1',
    durationMs: 720,
  } as ConversationEvent);
  const afterDone = deps.calls.setMessagesCalls[1]!(afterStart);

  expect(afterDone.length).toBe(1);
  expect(afterDone[0].text).toBe('Compacted context (0.7s).');
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
