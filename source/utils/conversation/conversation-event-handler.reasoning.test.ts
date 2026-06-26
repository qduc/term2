import { it, expect } from 'vitest';
import { createConversationEventHandler } from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import { createMockDeps } from './test-helpers/event-handler-fixtures.js';

it('reasoning_delta: accumulates reasoning after flushed position', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'ing',
    fullText: 'Thinking',
  } as ConversationEvent);

  expect(state.accumulatedReasoningText).toBe('Thinking');
  expect(deps.calls.reasoningPushes).toEqual(['Thinking']);
});

it('reasoning_delta: skips already flushed reasoning', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.flushedReasoningLength = 5; // Already flushed "Think"
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'ing',
    fullText: 'Thinking',
  } as ConversationEvent);

  expect(state.accumulatedReasoningText).toBe('ing');
  expect(deps.calls.reasoningPushes).toEqual(['ing']);
});

it('reasoning_delta: ignores empty reasoning', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: '',
    fullText: '   ',
  } as ConversationEvent);

  expect(state.accumulatedReasoningText).toBe('   ');
  expect(deps.calls.reasoningPushes).toEqual([]);
});

it('reasoning_delta: finalizes stable paragraphs and streams only the unfinished tail', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'tail',
    fullText: 'First paragraph.\n\nSecond paragraph.\n\nCurrent tail',
  } as ConversationEvent);

  expect(deps.calls.appendedMessages.length).toBe(1);
  expect(deps.calls.appendedMessages[0]).toEqual([
    {
      id: 'msg-0',
      sender: 'reasoning',
      status: 'finalized',
      text: 'First paragraph.\n\nSecond paragraph.\n\n',
    },
  ]);
  expect(state.flushedReasoningLength).toBe('First paragraph.\n\nSecond paragraph.\n\n'.length);
  expect(state.accumulatedReasoningText).toBe('Current tail');
  expect(deps.calls.reasoningPushes).toEqual(['Current tail']);
});

it('reasoning_delta: does not finalize until a paragraph boundary exists', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'tail',
    fullText: 'Single paragraph still growing',
  } as ConversationEvent);

  expect(deps.calls.appendedMessages).toEqual([]);
  expect(state.flushedReasoningLength).toBe(0);
  expect(state.accumulatedReasoningText).toBe('Single paragraph still growing');
  expect(deps.calls.reasoningPushes).toEqual(['Single paragraph still growing']);
});

it('text_delta: finalizes a live reasoning tail before streaming assistant text', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentReasoningMessageId = 'active-reasoning';
  state.accumulatedReasoningText = 'Final reasoning tail';
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: 'Answer starts.' } as ConversationEvent);

  expect(deps.calls.reasoningFlushed).toBe(true);
  expect(deps.calls.setMessagesCalls.length).toBe(1);
  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      text: 'Final reasoning tail',
    },
  ]);

  expect(next).toEqual([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      status: 'finalized',
      text: 'Final reasoning tail',
    },
  ]);
  expect(state.currentReasoningMessageId).toBeNull();
  expect(state.accumulatedReasoningText).toBe('');
  expect(state.flushedReasoningLength).toBe('Final reasoning tail'.length);
  expect(deps.calls.botResponsePushes).toEqual(['Answer starts.']);
});

it('reasoning_delta: finalizes an existing live reasoning message in place before streaming a new tail', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentReasoningMessageId = 'active-reasoning';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'tail',
    fullText: 'Old tail now complete.\n\nNew tail',
  } as ConversationEvent);

  expect(deps.calls.appendedMessages).toEqual([]);
  expect(deps.calls.setMessagesCalls.length).toBe(1);

  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      text: 'Old tail',
    },
  ]);

  expect(next).toEqual([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      status: 'finalized',
      text: 'Old tail now complete.\n\n',
    },
  ]);
  expect(state.currentReasoningMessageId === null).toBe(true);
  expect(state.flushedReasoningLength).toBe('Old tail now complete.\n\n'.length);
  expect(state.accumulatedReasoningText).toBe('New tail');
  expect(deps.calls.reasoningPushes).toEqual(['New tail']);
  expect(deps.calls.reasoningCancelled).toBe(true);
});

it('reasoning_delta: keeps the final paragraph mutable when only trailing whitespace follows it', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentReasoningMessageId = 'active-reasoning';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: '\n\n',
    fullText: 'Finished reasoning paragraph.\n\n',
  } as ConversationEvent);

  expect(deps.calls.setMessagesCalls.length).toBe(0);
  expect(deps.calls.reasoningCancelled).toBe(false);
  expect(deps.calls.reasoningPushes).toEqual(['Finished reasoning paragraph.\n\n']);
  expect(state.accumulatedReasoningText).toBe('Finished reasoning paragraph.\n\n');
  expect(state.currentReasoningMessageId).toBe('active-reasoning');
});

it('reasoning_delta: does not drop prefix when reasoning restarts after a tool', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'Before tool',
    fullText: 'Before tool',
  } as ConversationEvent);

  handler({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'ls' },
  } as ConversationEvent);

  handler({
    type: 'reasoning_delta',
    delta: 'After tool reasoning',
    fullText: 'After tool reasoning',
  } as ConversationEvent);

  expect(state.accumulatedReasoningText).toBe('After tool reasoning');
  expect(deps.calls.reasoningPushes).toEqual(['Before tool', 'After tool reasoning']);
});
