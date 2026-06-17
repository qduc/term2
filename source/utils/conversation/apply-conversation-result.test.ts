import { it, expect } from 'vitest';
import {
  computeNextMessages,
  isStreamingBotMessageId,
  clearStreamingBotMessage,
  type ApplyConversationResultOptions,
} from './apply-conversation-result.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';
import type { CommandMessage, Message } from '../../types/message.js';
import { createStreamingState, type StreamingState } from './conversation-utils.js';

let idCounter = 0;
const createMessageId = (): string => `m${idCounter++}`;

const passthrough = <T>(value: T): T => value;
const identityAnnotate = (msg: CommandMessage): CommandMessage => msg;

interface Harness {
  options: ApplyConversationResultOptions;
  streamingState: StreamingState;
}

const makeHarness = (overrides?: Partial<ApplyConversationResultOptions>): Harness => {
  const streamingState = createStreamingState();
  const harness: Harness = {
    streamingState,
    options: {
      result: { type: 'response', commandMessages: [], finalText: '' },
      streamingState,
      createMessageId,
      trimMessages: passthrough,
      annotateCommandMessage: identityAnnotate,
      ...overrides,
    },
  };
  return harness;
};

const makeResponse = (
  overrides?: Partial<Extract<ConversationTerminal, { type: 'response' }>>,
): ConversationTerminal => ({
  type: 'response',
  commandMessages: [],
  finalText: '',
  ...overrides,
});

it('appends a new finalized bot message when no streaming happened (sync provider path)', () => {
  const { options, streamingState } = makeHarness();
  idCounter = 0;
  const prev: Message[] = [];
  const { next, finalizedStreamingMessage } = computeNextMessages({
    ...options,
    result: makeResponse({ finalText: 'Hello world.' }),
    prev,
  });
  expect(finalizedStreamingMessage).toBe(false);
  expect(next).toEqual([{ id: 'm0', sender: 'bot', status: 'finalized', text: 'Hello world.' }]);
  expect(streamingState.currentBotMessageId === null).toBe(true);
  expect(streamingState.textWasFlushed).toBe(false);
});

it('does not duplicate bot text when a streaming message exists and no boundary flushed', () => {
  // Regression: the streaming event handler kept a "status: 'streaming'" bot
  // message live while text_delta events arrived. applyServiceResult used to
  // also append a finalized copy of the same finalText, so users saw the
  // assistant's reply rendered twice.
  const { options, streamingState } = makeHarness();
  idCounter = 0;

  // Simulate the post-streaming state: accumulatedText reflects everything
  // the handler has received, flushedTextLength is 0 because no safe
  // boundary was crossed, and currentBotMessageId points at the live message.
  streamingState.accumulatedText = 'All 2868 tests pass.';
  streamingState.flushedTextLength = 0;
  streamingState.currentBotMessageId = 'live-bot';

  const prev: Message[] = [
    { id: 'user-1', sender: 'user', text: 'Run tests' },
    { id: 'live-bot', sender: 'bot', status: 'streaming', text: 'All 2868 tests pass.' },
  ];

  const { next, finalizedStreamingMessage } = computeNextMessages({
    ...options,
    result: makeResponse({ finalText: 'All 2868 tests pass.' }),
    prev,
  });

  expect(finalizedStreamingMessage).toBe(true);
  expect(next).toEqual([
    { id: 'user-1', sender: 'user', text: 'Run tests' },
    { id: 'live-bot', sender: 'bot', status: 'finalized', text: 'All 2868 tests pass.' },
  ]);
  // Caller is expected to clear the streaming state bookkeeping when the
  // streaming message has been promoted to finalized.
  clearStreamingBotMessage(streamingState);
  expect(streamingState.currentBotMessageId === null).toBe(true);
  expect(streamingState.textWasFlushed).toBe(true);
});

it('does not duplicate the flushed prefix when only the tail is still streaming', () => {
  // When the stream crossed a safe boundary mid-text the handler promotes
  // the prefix to a finalized message and starts a fresh streaming message
  // for the tail. applyServiceResult must finalize only the tail, not the
  // whole accumulated output, otherwise the prefix would be re-emitted.
  const { options, streamingState } = makeHarness();
  idCounter = 0;

  streamingState.accumulatedText = 'First paragraph.\n\nSecond paragraph.\n\nCurrent tail';
  streamingState.flushedTextLength = 'First paragraph.\n\nSecond paragraph.\n\n'.length;
  streamingState.currentBotMessageId = 'live-bot';

  const prev: Message[] = [
    {
      id: 'flushed-1',
      sender: 'bot',
      status: 'finalized',
      text: 'First paragraph.\n\nSecond paragraph.\n\n',
    },
    { id: 'live-bot', sender: 'bot', status: 'streaming', text: 'Current tail' },
  ];

  const { next, finalizedStreamingMessage } = computeNextMessages({
    ...options,
    result: makeResponse({ finalText: 'First paragraph.\n\nSecond paragraph.\n\nCurrent tail' }),
    prev,
  });

  expect(finalizedStreamingMessage).toBe(true);
  expect(next).toEqual([
    {
      id: 'flushed-1',
      sender: 'bot',
      status: 'finalized',
      text: 'First paragraph.\n\nSecond paragraph.\n\n',
    },
    { id: 'live-bot', sender: 'bot', status: 'finalized', text: 'Current tail' },
  ]);
});

it('does not append when textWasFlushed and no streaming message remains', () => {
  // The streaming message may have already been promoted to a finalized
  // message by the handler (e.g. via a tool_started event) so the final
  // result's finalText is the tail that is already represented. We must
  // not append it a second time.
  const { options, streamingState } = makeHarness();
  idCounter = 0;

  streamingState.textWasFlushed = true;
  streamingState.currentBotMessageId = null;

  const prev: Message[] = [{ id: 'flushed-1', sender: 'bot', status: 'finalized', text: 'Finalized tail.' }];

  const { next, finalizedStreamingMessage } = computeNextMessages({
    ...options,
    result: makeResponse({ finalText: 'Finalized tail.' }),
    prev,
  });

  expect(finalizedStreamingMessage).toBe(false);
  expect(next).toEqual([{ id: 'flushed-1', sender: 'bot', status: 'finalized', text: 'Finalized tail.' }]);
});

it('merges command messages into the response result', () => {
  const { options } = makeHarness({
    annotateCommandMessage: identityAnnotate,
  });
  idCounter = 0;

  const commandMessage: CommandMessage = {
    id: 'cmd-1',
    sender: 'command',
    status: 'completed',
    command: 'echo hi',
    output: 'hi',
    callId: 'cmd-1',
    toolName: 'shell',
  };

  const { next } = computeNextMessages({
    ...options,
    result: makeResponse({ commandMessages: [commandMessage], finalText: 'Done.' }),
    prev: [{ id: 'user-1', sender: 'user', text: 'hi' }],
  });

  expect(next).toEqual([
    { id: 'user-1', sender: 'user', text: 'hi' },
    commandMessage,
    { id: 'm0', sender: 'bot', status: 'finalized', text: 'Done.' },
  ]);
});

it('skips the bot text when finalText is empty/whitespace', () => {
  const { options } = makeHarness();
  idCounter = 0;
  const { next } = computeNextMessages({
    ...options,
    result: makeResponse({ finalText: '   \n' }),
    prev: [],
  });
  expect(next).toEqual([]);
});

it('isStreamingBotMessageId: returns id only when the live message still exists', () => {
  const streamingState = createStreamingState();
  streamingState.currentBotMessageId = 'live-bot';
  const messages: Message[] = [{ id: 'live-bot', sender: 'bot', status: 'streaming', text: 'x' }];
  expect(isStreamingBotMessageId(streamingState, messages)).toBe('live-bot');

  // Message no longer in the list (e.g. trimmed or replaced)
  expect(isStreamingBotMessageId(streamingState, [])).toBe(null);
  streamingState.currentBotMessageId = null;
  expect(isStreamingBotMessageId(streamingState, messages)).toBe(null);
});

it('clearStreamingBotMessage resets the streaming state', () => {
  const streamingState = createStreamingState();
  streamingState.currentBotMessageId = 'live-bot';
  streamingState.accumulatedText = 'tail';
  streamingState.flushedTextLength = 5;
  clearStreamingBotMessage(streamingState);
  expect(streamingState.currentBotMessageId === null).toBe(true);
  expect(streamingState.accumulatedText).toBe('');
  expect(streamingState.flushedTextLength).toBe(0);
  expect(streamingState.textWasFlushed).toBe(true);
});
