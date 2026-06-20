import { it, expect } from 'vitest';
import { createConversationEventHandler } from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import { createMockDeps } from './test-helpers/event-handler-fixtures.js';

it('tool_started: flushes accumulated text before showing tool', () => {
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

  expect(state.accumulatedText).toBe('');
  expect(state.textWasFlushed).toBe(true);
  expect(deps.calls.botResponseCancelled).toBe(true);
  // Should append text message and command message
  expect(deps.calls.appendedMessages.length).toBe(2);
  expect(deps.calls.appendedMessages[0][0].sender).toBe('bot');
  expect(deps.calls.appendedMessages[0][0].status).toBe('finalized');
  expect(deps.calls.appendedMessages[0][0].text).toBe('Some text before tool');
});

it('tool_started: flushes accumulated reasoning before showing tool', () => {
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

  expect(deps.calls.reasoningFlushed).toBe(true);
  expect(state.accumulatedReasoningText).toBe('');
  expect(state.flushedReasoningLength).toBe(14); // 'Some reasoning'.length
  expect(state.currentReasoningMessageId === null).toBe(true);
});

it('tool_started: finalizes live reasoning text before clearing it', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentReasoningMessageId = 'active-reasoning';
  state.accumulatedReasoningText = 'Reasoning before the tool';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'ls' },
  } as ConversationEvent);

  expect(deps.calls.reasoningFlushed).toBe(true);
  expect(deps.calls.setMessagesCalls.length).toBe(1);

  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      text: 'Reasoning before the tool',
    },
  ]);

  expect(next).toEqual([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      status: 'finalized',
      text: 'Reasoning before the tool',
    },
  ]);
  expect(state.accumulatedReasoningText).toBe('');
  expect(state.flushedReasoningLength).toBe('Reasoning before the tool'.length);
  expect(state.currentReasoningMessageId === null).toBe(true);
});

it('tool_started: creates pending command message with shell command', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'echo hello' },
  } as ConversationEvent);

  expect(deps.calls.appendedMessages.length).toBe(1);
  const cmdMsg = deps.calls.appendedMessages[0][0];
  expect(cmdMsg.sender).toBe('command');
  expect(cmdMsg.status).toBe('running');
  expect(cmdMsg.command).toBe('echo hello');
  expect(cmdMsg.toolName).toBe('shell');
  expect(cmdMsg.callId).toBe('call-1');
});

it('tool_started: parses JSON string arguments', () => {
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
  expect(cmdMsg.command).toBe('pwd');
  expect(cmdMsg.toolArgs).toEqual({ command: 'pwd' });
});

it('tool_started: formats grep command correctly', () => {
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
  expect(cmdMsg.command).toBe('grep "TODO" src/');
});

it('tool_started: skips pending message for run_subagent (SubagentActivityMessage handles display)', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-sa-1',
    toolName: 'run_subagent',
    arguments: { role: 'worker', task: 'fix the bug' },
  } as ConversationEvent);

  expect(deps.calls.appendedMessages.length).toBe(0);
});

it('tool_started: does not append duplicate running message for the same callId', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-dup-1',
    toolName: 'shell',
    arguments: { command: 'ls -la' },
  } as ConversationEvent);

  handler({
    type: 'tool_started',
    toolCallId: 'call-dup-1',
    toolName: 'shell',
    arguments: { command: 'ls -la' },
  } as ConversationEvent);

  expect(deps.calls.appendedMessages.length).toBe(1);
  expect(deps.calls.appendedMessages[0][0].callId).toBe('call-dup-1');
  expect(deps.calls.appendedMessages[0][0].status).toBe('running');
});

it('command_message: annotates and updates existing pending message', () => {
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

  expect(deps.calls.setMessagesCalls.length).toBe(1);
  // The annotateCommandMessage should have been called
  const updater = deps.calls.setMessagesCalls[0]!;
  const existingMessages = [{ id: 'call-1', sender: 'command', status: 'running', callId: 'call-1' }];
  const result = updater(existingMessages);
  expect(result[0].annotated).toBe(true);
  expect(result[0].status).toBe('completed');
});

it('command_message: adds new message if no pending exists', () => {
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
  expect(result.length).toBe(2);
  expect(result[1].annotated).toBe(true);
});

it('command_message: flushes accumulated text before adding', () => {
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

  expect(state.accumulatedText).toBe('');
  expect(state.textWasFlushed).toBe(true);
  expect(deps.calls.appendedMessages.length).toBe(1);
  expect(deps.calls.appendedMessages[0][0].status).toBe('finalized');
  expect(deps.calls.appendedMessages[0][0].text).toBe('Partial response');
});

it('tool_recovery: marks dropped running commands failed and appends recovery note', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_recovery',
    recoveredCallIds: ['call-read'],
    droppedCallIds: ['call-write'],
    message:
      'Recovered 1 completed tool call/result pair(s) from a previously interrupted turn. Dropped 1 incomplete tool call(s); do not assume dropped calls completed.',
  } as ConversationEvent);

  expect(deps.calls.setMessagesCalls.length).toBe(1);
  const next = deps.calls.setMessagesCalls[0]!([
    {
      id: 'read',
      sender: 'command',
      status: 'completed',
      command: 'read_file source/a.ts',
      output: 'contents',
      callId: 'call-read',
    },
    {
      id: 'write',
      sender: 'command',
      status: 'running',
      command: 'apply_patch',
      output: '',
      callId: 'call-write',
    },
  ]);

  expect(next[0].status).toBe('completed');
  expect(next[1].status).toBe('failed');
  expect(next[1].failureReason).toBe('Dropped during recovery');
  expect(next[1].output.includes('not sent to model history')).toBe(true);
  expect(next[2].sender).toBe('system');
  expect(next[2].text.startsWith('Recovered 1 completed')).toBe(true);
});

it('retry: adds system message about hallucination retry', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'shell',
    attempt: 1,
    maxRetries: 2,
    errorMessage: 'Tool hallucination detected',
    retryType: 'hallucination',
  } as ConversationEvent);

  expect(deps.calls.setMessagesCalls.length).toBe(1);
  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('system');
  expect(result[0].text.includes('shell')).toBe(true);
  expect(result[0].text.includes('1/2')).toBe(true);
});

it('retry: adds generic system message when retryType is undefined', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'shell',
    attempt: 1,
    maxRetries: 2,
    errorMessage: 'Generic retry error',
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('system');
  expect(result[0].text).toBe('Retrying... (Attempt 1/2)');
});

it('retry: adds system message about flex service tier fallback', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'service_tier',
    attempt: 1,
    maxRetries: 1,
    errorMessage: 'Flex service tier timed out',
    retryType: 'flex_service_tier',
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('system');
  expect(result[0].text.includes('Flex service tier timed out')).toBe(true);
  expect(result[0].text.includes('standard service tier')).toBe(true);
});

it('retry: adds system message about upstream retry', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'continuation',
    attempt: 1,
    maxRetries: 3,
    errorMessage: 'Connection error',
    retryType: 'upstream',
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('system');
  expect(result[0].text).toBe('Upstream error or rate limit encountered. Retrying... (Attempt 1/3)');
});

it('retry: adds system message about parsing error retry', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'model',
    attempt: 1,
    maxRetries: 2,
    errorMessage: 'JSON parse error',
    retryType: 'parsing_error',
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('system');
  expect(result[0].text).toBe('Model parsing error detected. Retrying... (Attempt 1/2)');
});

it('retry: adds system message about behavior error retry', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'model',
    attempt: 2,
    maxRetries: 2,
    errorMessage: 'Did not produce final response',
    retryType: 'behavior',
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('system');
  expect(result[0].text).toBe('Model behavior error detected. Retrying... (Attempt 2/2)');
});

it('final: finalizes trailing reasoning message that was never followed by a tool call', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentReasoningMessageId = 'active-reasoning';
  state.accumulatedReasoningText = 'Trailing reasoning with no tool call';
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'final', finalText: '' } as any);

  expect(deps.calls.reasoningFlushed).toBe(true);
  expect(state.accumulatedReasoningText).toBe('');
  expect(state.currentReasoningMessageId === null).toBe(true);

  // markCurrentReasoningFinalized sets status via setMessages
  expect(deps.calls.setMessagesCalls.length).toBe(1);
  const next = deps.calls.setMessagesCalls[0]!([
    { id: 'active-reasoning', sender: 'reasoning', text: 'Trailing reasoning with no tool call' },
  ]);
  expect(next).toEqual([
    { id: 'active-reasoning', sender: 'reasoning', status: 'finalized', text: 'Trailing reasoning with no tool call' },
  ]);
});

it('final: appends missing final text after already flushed streamed text', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: 'Intro\n\n' } as ConversationEvent);
  handler({ type: 'final', finalText: 'Intro\n\n## Missing Header\n\nBody' } as ConversationEvent);

  expect(state.accumulatedText).toBe('Intro\n\n## Missing Header\n\nBody');
  expect(deps.calls.appendedMessages.length).toBe(1);
  expect(deps.calls.appendedMessages[0]).toEqual([
    {
      id: 'msg-0',
      sender: 'bot',
      status: 'finalized',
      text: 'Intro\n\n## Missing Header\n\nBody',
    },
  ]);
});

it('final: is a no-op when there is no pending reasoning', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'final', finalText: '' } as any);

  expect(deps.calls.reasoningFlushed).toBe(false);
  expect(deps.calls.setMessagesCalls.length).toBe(0);
  expect(deps.calls.appendedMessages.length).toBe(0);
});

it('unknown event: is ignored without error', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // Should not throw
  handler({ type: 'unknown_event' } as any);

  expect(deps.calls.appendedMessages.length).toBe(0);
  expect(deps.calls.setMessagesCalls.length).toBe(0);
});

it('final: ignores corrected finalText when it is the same length as accumulated streamed text', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  // Simulate streaming that produced a typo whose length matches the correct text
  state.accumulatedText = 'Hello wrold';
  state.flushedTextLength = 0;
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'final', finalText: 'Hello world' } as any);

  // The guard `finalText.length > accumulatedText.length` is false for equal-length strings.
  // accumulatedText is never updated, so the typo is what gets flushed.
  expect(deps.calls.appendedMessages.length).toBe(1);
  const flushedMsg = deps.calls.appendedMessages[0][0];
  // Fails: actual is 'Hello wrold' (the typo) — correction from finalText is silently lost
  expect(flushedMsg.text).toBe('Hello world');
});

it('final: flushes over-accumulated streamed content when finalText is shorter than accumulated', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  // Simulate streaming that over-shot the authoritative answer
  state.accumulatedText = 'The answer is 42. Extra hallucinated sentence.';
  state.flushedTextLength = 0;
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'final', finalText: 'The answer is 42.' } as any);

  // The guard `finalText.length > accumulatedText.length` is false when final is shorter.
  // accumulatedText is not corrected, so the hallucinated tail is included in the flush.
  expect(deps.calls.appendedMessages.length).toBe(1);
  const flushedMsg = deps.calls.appendedMessages[0][0];
  // Fails: actual is the full over-accumulated string including ' Extra hallucinated sentence.'
  expect(flushedMsg.text).toBe('The answer is 42.');
});

it('command_message: leaves stale running message when no callId is present on either side', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // tool_started with no callId appends a running message with no way to match it later
  handler({
    type: 'tool_started',
    toolCallId: undefined,
    toolName: 'shell',
    arguments: { command: 'ls' },
  } as any);

  const runningMsg = deps.calls.appendedMessages[0][0];
  expect(runningMsg.status).toBe('running');
  expect(runningMsg.callId).toBe(undefined);

  // command_message also has no callId, so pendingIndex is immediately -1
  // and the completed message is appended rather than replacing the running one
  handler({
    type: 'command_message',
    message: {
      id: 'result-1',
      sender: 'command',
      status: 'completed',
      command: 'ls',
      output: 'file.txt',
      callId: undefined,
      toolName: 'shell',
    },
  } as any);

  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([runningMsg]);

  // Fails: result has 2 messages — the stale 'running' + the new 'completed'
  // Expected: 1 message, the running entry replaced by the completed one
  expect(result.length).toBe(1);
  expect(result[0].status).toBe('completed');
});

it('command_message: preserves the id of the running message when replacing it', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'command_message',
    message: {
      id: 'call-1-0', // different id from the running command
      sender: 'command',
      status: 'completed',
      command: 'ls',
      output: 'file.txt',
      callId: 'call-1',
      toolName: 'shell',
    },
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const existingMessages = [{ id: 'call-1', sender: 'command', status: 'running', callId: 'call-1' }];
  const result = updater(existingMessages);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe('call-1'); // preserves running message id
  expect(result[0].status).toBe('completed');
});

it('command_message: preserves running ids for batch completions matched by callId', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'command_message',
    message: {
      id: 'call-1-0',
      sender: 'command',
      status: 'completed',
      command: 'read_file file1.ts',
      output: 'content1',
      callId: 'call-1',
      toolName: 'read_file',
    },
  } as ConversationEvent);

  handler({
    type: 'command_message',
    message: {
      id: 'call-2-0',
      sender: 'command',
      status: 'completed',
      command: 'read_file file2.ts',
      output: 'content2',
      callId: 'call-2',
      toolName: 'read_file',
    },
  } as ConversationEvent);

  const firstUpdater = deps.calls.setMessagesCalls[0]!;
  const secondUpdater = deps.calls.setMessagesCalls[1]!;
  const afterFirst = firstUpdater([
    { id: 'call-1', sender: 'command', status: 'running', callId: 'call-1' },
    { id: 'call-2', sender: 'command', status: 'running', callId: 'call-2' },
  ]);
  const afterSecond = secondUpdater(afterFirst);

  expect(
    afterSecond.map((message) => ({
      id: message.id,
      callId: (message as any).callId,
      status: message.status,
    })),
  ).toEqual([
    { id: 'call-1', callId: 'call-1', status: 'completed' },
    { id: 'call-2', callId: 'call-2', status: 'completed' },
  ]);
});
