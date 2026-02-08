import test from 'ava';
import { createConversationEventHandler, type ConversationEventHandlerDeps } from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../services/conversation-events.js';

// =============================================================================
// Test Helpers
// =============================================================================

interface MockDeps extends ConversationEventHandlerDeps {
  liveResponseUpdater: { push: (text: string) => void; cancel: () => void; flush: () => void };
  reasoningUpdater: { push: (text: string) => void; cancel: () => void; flush: () => void };
  appendMessages: (messages: any[]) => void;
  setMessages: (updater: (prev: any[]) => any[]) => void;
  setLiveResponse: (response: any) => void;
  trimMessages: (messages: any[]) => any[];
  annotateCommandMessage: (msg: any) => any;
}

function createMockDeps(): MockDeps & {
  calls: {
    liveResponsePushes: string[];
    liveResponseCancelled: boolean;
    liveResponseFlushed: boolean;
    reasoningPushes: string[];
    reasoningFlushed: boolean;
    appendedMessages: any[][];
    setMessagesCalls: Array<(prev: any[]) => any[]>;
    liveResponses: any[];
  };
} {
  const calls = {
    liveResponsePushes: [] as string[],
    liveResponseCancelled: false,
    liveResponseFlushed: false,
    reasoningPushes: [] as string[],
    reasoningFlushed: false,
    appendedMessages: [] as any[][],
    setMessagesCalls: [] as Array<(prev: any[]) => any[]>,
    liveResponses: [] as any[],
  };

  return {
    calls,
    liveResponseUpdater: {
      push: (text: string) => calls.liveResponsePushes.push(text),
      cancel: () => {
        calls.liveResponseCancelled = true;
      },
      flush: () => {
        calls.liveResponseFlushed = true;
      },
    },
    reasoningUpdater: {
      push: (text: string) => calls.reasoningPushes.push(text),
      cancel: () => {},
      flush: () => {
        calls.reasoningFlushed = true;
      },
    },
    appendMessages: (messages: any[]) => calls.appendedMessages.push(messages),
    setMessages: (updater: (prev: any[]) => any[]) => calls.setMessagesCalls.push(updater),
    setLiveResponse: (response: any) => calls.liveResponses.push(response),
    trimMessages: (messages: any[]) => messages,
    annotateCommandMessage: (msg: any) => ({ ...msg, annotated: true }),
  };
}

// =============================================================================
// text_delta tests
// =============================================================================

test('text_delta: accumulates text and pushes to live response', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: 'Hello ' } as ConversationEvent);
  handler({ type: 'text_delta', delta: 'world!' } as ConversationEvent);

  t.is(state.accumulatedText, 'Hello world!');
  t.deepEqual(deps.calls.liveResponsePushes, ['Hello ', 'Hello world!']);
});

// =============================================================================
// reasoning_delta tests
// =============================================================================

test('reasoning_delta: accumulates reasoning after flushed position', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'ing',
    fullText: 'Thinking',
  } as ConversationEvent);

  t.is(state.accumulatedReasoningText, 'Thinking');
  t.deepEqual(deps.calls.reasoningPushes, ['Thinking']);
});

test('reasoning_delta: skips already flushed reasoning', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.flushedReasoningLength = 5; // Already flushed "Think"
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'ing',
    fullText: 'Thinking',
  } as ConversationEvent);

  t.is(state.accumulatedReasoningText, 'ing');
  t.deepEqual(deps.calls.reasoningPushes, ['ing']);
});

test('reasoning_delta: ignores empty reasoning', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: '',
    fullText: '   ',
  } as ConversationEvent);

  t.is(state.accumulatedReasoningText, '   ');
  t.deepEqual(deps.calls.reasoningPushes, []);
});

// =============================================================================
// tool_started tests
// =============================================================================

test('tool_started: flushes accumulated text before showing tool', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.accumulatedText = 'Some text before tool';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'ls' },
  } as ConversationEvent);

  t.is(state.accumulatedText, '');
  t.is(state.textWasFlushed, true);
  t.true(deps.calls.liveResponseCancelled);
  // Should append text message and command message
  t.is(deps.calls.appendedMessages.length, 2);
  t.is(deps.calls.appendedMessages[0][0].sender, 'bot');
  t.is(deps.calls.appendedMessages[0][0].text, 'Some text before tool');
});

test('tool_started: flushes accumulated reasoning before showing tool', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.accumulatedReasoningText = 'Some reasoning';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'ls' },
  } as ConversationEvent);

  t.true(deps.calls.reasoningFlushed);
  t.is(state.accumulatedReasoningText, '');
  t.is(state.flushedReasoningLength, 14); // 'Some reasoning'.length
  t.is(state.currentReasoningMessageId, null);
});

test('tool_started: creates pending command message with shell command', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'echo hello' },
  } as ConversationEvent);

  t.is(deps.calls.appendedMessages.length, 1);
  const cmdMsg = deps.calls.appendedMessages[0][0];
  t.is(cmdMsg.sender, 'command');
  t.is(cmdMsg.status, 'running');
  t.is(cmdMsg.command, 'echo hello');
  t.is(cmdMsg.toolName, 'shell');
  t.is(cmdMsg.callId, 'call-1');
});

test('tool_started: parses JSON string arguments', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: '{"command": "pwd"}',
  } as ConversationEvent);

  const cmdMsg = deps.calls.appendedMessages[0][0];
  t.is(cmdMsg.command, 'pwd');
  t.deepEqual(cmdMsg.toolArgs, { command: 'pwd' });
});

test('tool_started: formats grep command correctly', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'grep',
    arguments: { pattern: 'TODO', path: 'src/' },
  } as ConversationEvent);

  const cmdMsg = deps.calls.appendedMessages[0][0];
  t.is(cmdMsg.command, 'grep "TODO" src/');
});

// =============================================================================
// command_message tests
// =============================================================================

test('command_message: annotates and updates existing pending message', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'command_message',
    message: {
      id: 'call-1',
      sender: 'command',
      status: 'completed',
      command: 'ls',
      output: 'file.txt',
      callId: 'call-1',
      toolName: 'shell',
    },
  } as ConversationEvent);

  t.is(deps.calls.setMessagesCalls.length, 1);
  // The annotateCommandMessage should have been called
  const updater = deps.calls.setMessagesCalls[0]!;
  const existingMessages = [{ id: 'call-1', sender: 'command', status: 'running', callId: 'call-1' }];
  const result = updater(existingMessages);
  t.true(result[0].annotated);
  t.is(result[0].status, 'completed');
});

test('command_message: adds new message if no pending exists', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'command_message',
    message: {
      id: 'call-new',
      sender: 'command',
      status: 'completed',
      command: 'ls',
      output: 'file.txt',
      callId: 'call-new',
      toolName: 'shell',
    },
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const existingMessages = [{ id: 1, sender: 'user', text: 'hi' }];
  const result = updater(existingMessages);
  t.is(result.length, 2);
  t.true(result[1].annotated);
});

test('command_message: flushes accumulated text before adding', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.accumulatedText = 'Partial response';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'command_message',
    message: {
      id: 'call-1',
      sender: 'command',
      status: 'completed',
      command: 'ls',
      output: '',
      callId: 'call-1',
    },
  } as ConversationEvent);

  t.is(state.accumulatedText, '');
  t.is(state.textWasFlushed, true);
  t.is(deps.calls.appendedMessages.length, 1);
  t.is(deps.calls.appendedMessages[0][0].text, 'Partial response');
});

// =============================================================================
// retry tests
// =============================================================================

test('retry: adds system message about hallucination retry', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'shell',
    attempt: 1,
    maxRetries: 2,
    errorMessage: 'Tool hallucination detected',
  } as ConversationEvent);

  t.is(deps.calls.setMessagesCalls.length, 1);
  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  t.is(result.length, 1);
  t.is(result[0].sender, 'system');
  t.true(result[0].text.includes('shell'));
  t.true(result[0].text.includes('1/2'));
});

// =============================================================================
// unknown event tests
// =============================================================================

test('unknown event: is ignored without error', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // Should not throw
  handler({ type: 'unknown_event' } as any);

  t.is(deps.calls.appendedMessages.length, 0);
  t.is(deps.calls.setMessagesCalls.length, 0);
});
