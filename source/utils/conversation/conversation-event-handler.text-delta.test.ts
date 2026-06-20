import { it, expect } from 'vitest';
import { createConversationEventHandler } from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import { createMockDeps } from './test-helpers/event-handler-fixtures.js';

it('text_delta: avoids splitting inside a code block and splits after it closes', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'text_delta',
    delta: 'Here is code:\n```javascript\nconst a = 1;\n\nconst b = 2;\n```\nTail',
  } as ConversationEvent);

  expect(deps.calls.setMessagesCalls.length).toBe(1);
  const next = deps.calls.setMessagesCalls[0]([]);
  expect(next[0].text).toBe('Here is code:\n```javascript\nconst a = 1;\n\nconst b = 2;\n```\n');
  expect(next[1].text).toBe('Tail');
  expect(state.accumulatedText).toBe('Here is code:\n```javascript\nconst a = 1;\n\nconst b = 2;\n```\nTail');
  expect(state.flushedTextLength).toBe('Here is code:\n```javascript\nconst a = 1;\n\nconst b = 2;\n```\n'.length);
});

it('text_delta: accumulates text and pushes to live response', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: 'Hello ' } as ConversationEvent);
  handler({ type: 'text_delta', delta: 'world!' } as ConversationEvent);

  expect(state.accumulatedText).toBe('Hello world!');
  expect(deps.calls.botResponsePushes).toEqual(['Hello ', 'Hello world!']);
});

it('text_delta: preserves newline between code fence language and first code line', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: '```typescript' } as ConversationEvent);
  handler({ type: 'text_delta', delta: '\n' } as ConversationEvent);
  handler({ type: 'text_delta', delta: 'if (enabled) {\n' } as ConversationEvent);

  expect(state.accumulatedText).toBe('```typescript\nif (enabled) {\n');
  expect(deps.calls.botResponsePushes.includes('```typescript\nif (enabled) {\n')).toBe(true);
});

it('text_delta: finalizes stable paragraphs and streams only the unfinished tail', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // Single delta that contains two complete paragraphs followed by an unfinished tail.
  // The handler should flush the completed paragraphs as a finalized message and
  // push only the tail to the live updater.
  handler({
    type: 'text_delta',
    delta: 'First paragraph.\n\nSecond paragraph.\n\nCurrent tail',
  } as ConversationEvent);

  expect(deps.calls.setMessagesCalls.length).toBe(1);
  expect(deps.calls.setMessagesCalls[0]([])).toEqual([
    {
      id: 'msg-0',
      sender: 'bot',
      status: 'finalized',
      text: 'First paragraph.\n\nSecond paragraph.\n\n',
    },
    {
      id: 'msg-1',
      sender: 'bot',
      status: 'streaming',
      text: 'Current tail',
    },
  ]);
  expect(state.flushedTextLength).toBe('First paragraph.\n\nSecond paragraph.\n\n'.length);
  expect(deps.calls.botResponseCancelled).toBe(true);
  expect(state.currentBotMessageId).toBe('msg-1');
});

it('text_delta: atomically commits a heading before its unfinished paragraph', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);
  const text = 'Earlier paragraph.\n\n---\n\n### The boundary\n\nThe dividing line is still streaming';

  handler({ type: 'text_delta', delta: text } as ConversationEvent);

  expect(deps.calls.setMessagesCalls[0]([])).toEqual([
    {
      id: 'msg-0',
      sender: 'bot',
      status: 'finalized',
      text: 'Earlier paragraph.\n\n---\n\n### The boundary\n\n',
    },
    {
      id: 'msg-1',
      sender: 'bot',
      status: 'streaming',
      text: 'The dividing line is still streaming',
    },
  ]);
});

it('text_delta: atomically replaces the live message with a finalized prefix and live suffix', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentBotMessageId = 'active-bot';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'text_delta',
    delta: 'First paragraph.\n\nCurrent tail',
  } as ConversationEvent);

  expect(deps.calls.setMessagesCalls.length).toBe(1);
  expect(
    deps.calls.setMessagesCalls[0]([
      { id: 'active-bot', sender: 'bot', status: 'streaming', text: 'First paragraph.' },
    ]),
  ).toEqual([
    {
      id: 'active-bot',
      sender: 'bot',
      status: 'finalized',
      text: 'First paragraph.\n\n',
    },
    {
      id: 'msg-0',
      sender: 'bot',
      status: 'streaming',
      text: 'Current tail',
    },
  ]);
  expect(state.currentBotMessageId).toBe('msg-0');
});

it('text_delta: does not finalize until a paragraph boundary exists', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: 'Single paragraph still growing' } as ConversationEvent);

  expect(deps.calls.appendedMessages).toEqual([]);
  expect(state.flushedTextLength).toBe(0);
  expect(state.accumulatedText).toBe('Single paragraph still growing');
  expect(deps.calls.botResponsePushes).toEqual(['Single paragraph still growing']);
});

it('text_delta: finalizes an existing live bot message in place before streaming a new tail', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentBotMessageId = 'active-bot';
  const handler = createConversationEventHandler(deps, state);

  // Arrive with a delta that completes the first paragraph and starts a new tail.
  // The handler should update the existing 'active-bot' message with the finalized
  // paragraph text and push the new tail to the live updater.
  handler({
    type: 'text_delta',
    delta: 'Old tail now complete.\n\nNew tail',
  } as ConversationEvent);

  expect(deps.calls.appendedMessages).toEqual([]);
  expect(deps.calls.setMessagesCalls.length).toBe(1);

  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-bot',
      sender: 'bot',
      text: 'Old tail',
    },
  ]);

  expect(next).toEqual([
    {
      id: 'active-bot',
      sender: 'bot',
      status: 'finalized',
      text: 'Old tail now complete.\n\n',
    },
    {
      id: 'msg-0',
      sender: 'bot',
      status: 'streaming',
      text: 'New tail',
    },
  ]);
  expect(state.currentBotMessageId).toBe('msg-0');
  expect(state.flushedTextLength).toBe('Old tail now complete.\n\n'.length);
  expect(deps.calls.botResponseCancelled).toBe(true);
});

it('text_delta: keeps the final paragraph mutable when only trailing whitespace follows it', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentBotMessageId = 'active-bot';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'text_delta',
    delta: 'Finished paragraph.\n\n',
  } as ConversationEvent);

  expect(deps.calls.setMessagesCalls.length).toBe(0);
  expect(deps.calls.botResponsePushes).toEqual(['Finished paragraph.\n\n']);
  expect(deps.calls.botResponseCancelled).toBe(false);
});

it('text_delta: preserves whitespace before the first block', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // Response begins with whitespace before the paragraph boundary
  handler({ type: 'text_delta', delta: '   \n\nActual content' } as ConversationEvent);

  expect(state.flushedTextLength).toBe(0);
  expect(deps.calls.appendedMessages.length).toBe(0);

  expect(deps.calls.botResponsePushes).toEqual(['   \n\nActual content']);

  handler({ type: 'final', finalText: '   \n\nActual content' } as any);
  expect(deps.calls.appendedMessages.length).toBe(1);
  expect(deps.calls.appendedMessages[0][0].text).toBe('   \n\nActual content');
});
