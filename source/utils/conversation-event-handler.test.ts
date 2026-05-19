import test from 'ava';
import {
  createConversationEventHandler,
  findLastSafeBoundary,
  type ConversationEventHandlerDeps,
} from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../services/conversation-events.js';

// =============================================================================
// Test Helpers
// =============================================================================

interface MockDeps extends ConversationEventHandlerDeps {
  botResponseUpdater: { push: (text: string) => void; cancel: () => void; flush: () => void };
  reasoningUpdater: { push: (text: string) => void; cancel: () => void; flush: () => void };
  appendMessages: (messages: any[]) => void;
  setMessages: (updater: (prev: any[]) => any[]) => void;
  createMessageId: () => string;
  trimMessages: (messages: any[]) => any[];
  annotateCommandMessage: (msg: any) => any;
}

function createMockDeps(): MockDeps & {
  calls: {
    botResponsePushes: string[];
    botResponseCancelled: boolean;
    botResponseFlushed: boolean;
    reasoningPushes: string[];
    reasoningFlushed: boolean;
    reasoningCancelled: boolean;
    appendedMessages: any[][];
    setMessagesCalls: Array<(prev: any[]) => any[]>;
  };
} {
  const calls = {
    botResponsePushes: [] as string[],
    botResponseCancelled: false,
    botResponseFlushed: false,
    reasoningPushes: [] as string[],
    reasoningFlushed: false,
    reasoningCancelled: false,
    appendedMessages: [] as any[][],
    setMessagesCalls: [] as Array<(prev: any[]) => any[]>,
  };

  return {
    calls,
    createMessageId: (() => {
      let seq = 0;
      return () => `msg-${seq++}`;
    })(),
    botResponseUpdater: {
      push: (text: string) => calls.botResponsePushes.push(text),
      cancel: () => {
        calls.botResponseCancelled = true;
      },
      flush: () => {
        calls.botResponseFlushed = true;
      },
    },
    reasoningUpdater: {
      push: (text: string) => calls.reasoningPushes.push(text),
      cancel: () => {
        calls.reasoningCancelled = true;
      },
      flush: () => {
        calls.reasoningFlushed = true;
      },
    },
    appendMessages: (messages: any[]) => calls.appendedMessages.push(messages),
    setMessages: (updater: (prev: any[]) => any[]) => calls.setMessagesCalls.push(updater),
    trimMessages: (messages: any[]) => messages,
    annotateCommandMessage: (msg: any) => ({ ...msg, annotated: true }),
  };
}

// =============================================================================
// findLastSafeBoundary tests
// =============================================================================

test('findLastSafeBoundary: splits on paragraph boundary', (t) => {
  const text = 'Paragraph 1\n\nParagraph 2';
  t.is(findLastSafeBoundary(text, 0), 13);
});

test('findLastSafeBoundary: ignores paragraph boundaries inside code blocks', (t) => {
  const text = '```javascript\nconst a = 1;\n\nconst b = 2;\n```\nMore text';
  const expectedBoundary = text.indexOf('```\nMore text') + 4; // after \n```\n
  t.is(findLastSafeBoundary(text, 0), expectedBoundary);
});

test('findLastSafeBoundary: splits at closing code blocks', (t) => {
  const text = 'Here is code:\n```javascript\ncode\n```\nTail';
  const expectedBoundary = text.indexOf('```\nTail') + 4;
  t.is(findLastSafeBoundary(text, 0), expectedBoundary);
});

test('findLastSafeBoundary: splits before headings', (t) => {
  const text = 'Paragraph 1\n# Heading 1';
  const expectedBoundary = text.indexOf('#'); // Split right before #
  t.is(findLastSafeBoundary(text, 0), expectedBoundary);
});

test('findLastSafeBoundary: splits on thematic breaks', (t) => {
  const text = 'Paragraph 1\n---\nParagraph 2';
  const expectedBoundary = text.indexOf('Paragraph 2'); // after \n---\n
  t.is(findLastSafeBoundary(text, 0), expectedBoundary);
});

// =============================================================================
// text_delta tests
// =============================================================================

test('text_delta: avoids splitting inside a code block and splits after it closes', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'text_delta',
    delta: 'Here is code:\n```javascript\nconst a = 1;\n\nconst b = 2;\n```\nTail',
  } as ConversationEvent);

  t.is(deps.calls.appendedMessages.length, 1);
  t.is(deps.calls.appendedMessages[0][0].text, 'Here is code:\n```javascript\nconst a = 1;\n\nconst b = 2;\n```\n');
  t.is(state.accumulatedText, 'Here is code:\n```javascript\nconst a = 1;\n\nconst b = 2;\n```\nTail');
  t.is(state.flushedTextLength, 'Here is code:\n```javascript\nconst a = 1;\n\nconst b = 2;\n```\n'.length);
});

test('text_delta: accumulates text and pushes to live response', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: 'Hello ' } as ConversationEvent);
  handler({ type: 'text_delta', delta: 'world!' } as ConversationEvent);

  t.is(state.accumulatedText, 'Hello world!');
  t.deepEqual(deps.calls.botResponsePushes, ['Hello ', 'Hello world!']);
});

test('text_delta: preserves newline between code fence language and first code line', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: '```typescript' } as ConversationEvent);
  handler({ type: 'text_delta', delta: '\n' } as ConversationEvent);
  handler({ type: 'text_delta', delta: 'if (enabled) {\n' } as ConversationEvent);

  t.is(state.accumulatedText, '```typescript\nif (enabled) {\n');
  t.true(deps.calls.botResponsePushes.includes('```typescript\nif (enabled) {\n'));
});

test('text_delta: finalizes stable paragraphs and streams only the unfinished tail', (t) => {
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

  t.is(deps.calls.appendedMessages.length, 1);
  t.deepEqual(deps.calls.appendedMessages[0], [
    {
      id: 'msg-0',
      sender: 'bot',
      status: 'finalized',
      text: 'First paragraph.\n\nSecond paragraph.\n\n',
    },
  ]);
  t.is(state.flushedTextLength, 'First paragraph.\n\nSecond paragraph.\n\n'.length);
  t.deepEqual(deps.calls.botResponsePushes, ['Current tail']);
  t.true(deps.calls.botResponseCancelled);
});

test('text_delta: does not finalize until a paragraph boundary exists', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: 'Single paragraph still growing' } as ConversationEvent);

  t.deepEqual(deps.calls.appendedMessages, []);
  t.is(state.flushedTextLength, 0);
  t.is(state.accumulatedText, 'Single paragraph still growing');
  t.deepEqual(deps.calls.botResponsePushes, ['Single paragraph still growing']);
});

test('text_delta: finalizes an existing live bot message in place before streaming a new tail', (t) => {
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

  t.deepEqual(deps.calls.appendedMessages, []);
  t.is(deps.calls.setMessagesCalls.length, 1);

  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-bot',
      sender: 'bot',
      text: 'Old tail',
    },
  ]);

  t.deepEqual(next, [
    {
      id: 'active-bot',
      sender: 'bot',
      status: 'finalized',
      text: 'Old tail now complete.\n\n',
    },
  ]);
  t.true(state.currentBotMessageId === null);
  t.is(state.flushedTextLength, 'Old tail now complete.\n\n'.length);
  t.deepEqual(deps.calls.botResponsePushes, ['New tail']);
  t.true(deps.calls.botResponseCancelled);
});

test('text_delta: cancels pending live bot update when paragraph boundary leaves no tail', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentBotMessageId = 'active-bot';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'text_delta',
    delta: 'Finished paragraph.\n\n',
  } as ConversationEvent);

  t.is(deps.calls.setMessagesCalls.length, 1);
  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-bot',
      sender: 'bot',
      status: 'streaming',
      text: 'Finished paragraph.',
    },
  ]);

  t.deepEqual(next, [
    {
      id: 'active-bot',
      sender: 'bot',
      status: 'finalized',
      text: 'Finished paragraph.\n\n',
    },
  ]);
  t.deepEqual(deps.calls.botResponsePushes, []);
  t.true(deps.calls.botResponseCancelled);
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

test('reasoning_delta: finalizes stable paragraphs and streams only the unfinished tail', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'tail',
    fullText: 'First paragraph.\n\nSecond paragraph.\n\nCurrent tail',
  } as ConversationEvent);

  t.is(deps.calls.appendedMessages.length, 1);
  t.deepEqual(deps.calls.appendedMessages[0], [
    {
      id: 'msg-0',
      sender: 'reasoning',
      status: 'finalized',
      text: 'First paragraph.\n\nSecond paragraph.\n\n',
    },
  ]);
  t.is(state.flushedReasoningLength, 'First paragraph.\n\nSecond paragraph.\n\n'.length);
  t.is(state.accumulatedReasoningText, 'Current tail');
  t.deepEqual(deps.calls.reasoningPushes, ['Current tail']);
});

test('reasoning_delta: does not finalize until a paragraph boundary exists', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'tail',
    fullText: 'Single paragraph still growing',
  } as ConversationEvent);

  t.deepEqual(deps.calls.appendedMessages, []);
  t.is(state.flushedReasoningLength, 0);
  t.is(state.accumulatedReasoningText, 'Single paragraph still growing');
  t.deepEqual(deps.calls.reasoningPushes, ['Single paragraph still growing']);
});

test('reasoning_delta: finalizes an existing live reasoning message in place before streaming a new tail', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentReasoningMessageId = 'active-reasoning';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: 'tail',
    fullText: 'Old tail now complete.\n\nNew tail',
  } as ConversationEvent);

  t.deepEqual(deps.calls.appendedMessages, []);
  t.is(deps.calls.setMessagesCalls.length, 1);

  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      text: 'Old tail',
    },
  ]);

  t.deepEqual(next, [
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      status: 'finalized',
      text: 'Old tail now complete.\n\n',
    },
  ]);
  t.true(state.currentReasoningMessageId === null);
  t.is(state.flushedReasoningLength, 'Old tail now complete.\n\n'.length);
  t.is(state.accumulatedReasoningText, 'New tail');
  t.deepEqual(deps.calls.reasoningPushes, ['New tail']);
  t.true(deps.calls.reasoningCancelled);
});

test('reasoning_delta: cancels pending live reasoning update when paragraph boundary leaves no tail', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentReasoningMessageId = 'active-reasoning';
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'reasoning_delta',
    delta: '\n\n',
    fullText: 'Finished reasoning paragraph.\n\n',
  } as ConversationEvent);

  t.is(deps.calls.setMessagesCalls.length, 1);
  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      text: 'Finished reasoning paragraph.',
    },
  ]);

  t.deepEqual(next, [
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      status: 'finalized',
      text: 'Finished reasoning paragraph.\n\n',
    },
  ]);
  t.true(deps.calls.reasoningCancelled);
  t.deepEqual(deps.calls.reasoningPushes, []);
  t.is(state.accumulatedReasoningText, '');
  t.true(state.currentReasoningMessageId === null);
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
  t.true(deps.calls.botResponseCancelled);
  // Should append text message and command message
  t.is(deps.calls.appendedMessages.length, 2);
  t.is(deps.calls.appendedMessages[0][0].sender, 'bot');
  t.is(deps.calls.appendedMessages[0][0].status, 'finalized');
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
  t.true(state.currentReasoningMessageId === null);
});

test('tool_started: finalizes live reasoning text before clearing it', (t) => {
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

  t.true(deps.calls.reasoningFlushed);
  t.is(deps.calls.setMessagesCalls.length, 1);

  const next = deps.calls.setMessagesCalls[0]([
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      text: 'Reasoning before the tool',
    },
  ]);

  t.deepEqual(next, [
    {
      id: 'active-reasoning',
      sender: 'reasoning',
      status: 'finalized',
      text: 'Reasoning before the tool',
    },
  ]);
  t.is(state.accumulatedReasoningText, '');
  t.is(state.flushedReasoningLength, 'Reasoning before the tool'.length);
  t.true(state.currentReasoningMessageId === null);
});

test('reasoning_delta: does not drop prefix when reasoning restarts after a tool', (t) => {
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

  t.is(state.accumulatedReasoningText, 'After tool reasoning');
  t.deepEqual(deps.calls.reasoningPushes, ['Before tool', 'After tool reasoning']);
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

test('tool_started: skips pending message for run_subagent (SubagentActivityMessage handles display)', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-sa-1',
    toolName: 'run_subagent',
    arguments: { role: 'worker', task: 'fix the bug' },
  } as ConversationEvent);

  t.is(deps.calls.appendedMessages.length, 0);
});

test('tool_started: does not append duplicate running message for the same callId', (t) => {
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

  t.is(deps.calls.appendedMessages.length, 1);
  t.is(deps.calls.appendedMessages[0][0].callId, 'call-dup-1');
  t.is(deps.calls.appendedMessages[0][0].status, 'running');
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
  t.is(deps.calls.appendedMessages[0][0].status, 'finalized');
  t.is(deps.calls.appendedMessages[0][0].text, 'Partial response');
});

// =============================================================================
// subagent activity tests
// =============================================================================

test('subagent events: maintains a live peek with the last three tools', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'inspect the command message rendering flow and report findings',
  } as ConversationEvent);

  t.deepEqual(deps.calls.appendedMessages[0], [
    {
      id: 'subagent-agent-1',
      sender: 'subagent',
      status: 'running',
      agentId: 'agent-1',
      role: 'explorer',
      task: 'inspect the command message rendering flow and report findings',
      tools: [],
    },
  ]);

  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'find_files',
    commandMessages: [{ id: 'find', sender: 'command', status: 'running', command: 'find_files "*.ts"', output: '' }],
  } as any);
  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'grep',
    commandMessages: [
      { id: 'grep', sender: 'command', status: 'running', command: 'grep "needle" "source"', output: '' },
    ],
  } as any);
  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'read_file',
    commandMessages: [
      { id: 'read', sender: 'command', status: 'running', command: 'read_file "source/app.tsx"', output: '' },
    ],
  } as any);
  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'read_code_outline',
    commandMessages: [
      {
        id: 'outline',
        sender: 'command',
        status: 'running',
        command: 'read_code_outline "source/app.tsx"',
        output: '',
      },
    ],
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  t.deepEqual(messages, [
    {
      id: 'subagent-agent-1',
      sender: 'subagent',
      status: 'running',
      agentId: 'agent-1',
      role: 'explorer',
      task: 'inspect the command message rendering flow and report findings',
      tools: ['grep "needle" "source"', 'read_file "source/app.tsx"', 'read_code_outline "source/app.tsx"'],
    },
  ]);
});

test('subagent_completed removes the live peek', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_completed',
    result: {
      agentId: 'agent-1',
      role: 'worker',
      status: 'completed',
      finalText: 'done',
      filesChanged: [],
      toolsUsed: [],
    },
  } as ConversationEvent);

  const result = deps.calls.setMessagesCalls[0]([
    {
      id: 'subagent-agent-1',
      sender: 'subagent',
      status: 'running',
      agentId: 'agent-1',
      role: 'worker',
      task: 'make the change',
      tools: ['apply_patch'],
    },
  ]);

  t.deepEqual(result, []);
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

test('retry: adds system message about flex service tier fallback', (t) => {
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
  t.is(result.length, 1);
  t.is(result[0].sender, 'system');
  t.true(result[0].text.includes('Flex service tier timed out'));
  t.true(result[0].text.includes('standard service tier'));
});

// =============================================================================
// final event tests
// =============================================================================

test('final: finalizes trailing reasoning message that was never followed by a tool call', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  state.currentReasoningMessageId = 'active-reasoning';
  state.accumulatedReasoningText = 'Trailing reasoning with no tool call';
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'final', finalText: '' } as any);

  t.true(deps.calls.reasoningFlushed);
  t.is(state.accumulatedReasoningText, '');
  t.true(state.currentReasoningMessageId === null);

  // markCurrentReasoningFinalized sets status via setMessages
  t.is(deps.calls.setMessagesCalls.length, 1);
  const next = deps.calls.setMessagesCalls[0]!([
    { id: 'active-reasoning', sender: 'reasoning', text: 'Trailing reasoning with no tool call' },
  ]);
  t.deepEqual(next, [
    { id: 'active-reasoning', sender: 'reasoning', status: 'finalized', text: 'Trailing reasoning with no tool call' },
  ]);
});

test('final: appends missing final text after already flushed streamed text', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'text_delta', delta: 'Intro\n\n' } as ConversationEvent);
  handler({ type: 'final', finalText: 'Intro\n\n## Missing Header\n\nBody' } as ConversationEvent);

  t.is(state.accumulatedText, 'Intro\n\n## Missing Header\n\nBody');
  t.is(deps.calls.appendedMessages.length, 2);
  t.deepEqual(deps.calls.appendedMessages[1], [
    {
      id: 'msg-1',
      sender: 'bot',
      status: 'finalized',
      text: '## Missing Header\n\nBody',
    },
  ]);
});

test('final: is a no-op when there is no pending reasoning', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'final', finalText: '' } as any);

  t.false(deps.calls.reasoningFlushed);
  t.is(deps.calls.setMessagesCalls.length, 0);
  t.is(deps.calls.appendedMessages.length, 0);
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

// =============================================================================
// Bug: final event silently ignores corrections when finalText.length <= accumulatedText.length
// =============================================================================

test('final: ignores corrected finalText when it is the same length as accumulated streamed text', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  // Simulate streaming that produced a typo whose length matches the correct text
  state.accumulatedText = 'Hello wrold';
  state.flushedTextLength = 0;
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'final', finalText: 'Hello world' } as any);

  // The guard `finalText.length > accumulatedText.length` is false for equal-length strings.
  // accumulatedText is never updated, so the typo is what gets flushed.
  t.is(deps.calls.appendedMessages.length, 1);
  const flushedMsg = deps.calls.appendedMessages[0][0];
  // Fails: actual is 'Hello wrold' (the typo) — correction from finalText is silently lost
  t.is(flushedMsg.text, 'Hello world');
});

test('final: flushes over-accumulated streamed content when finalText is shorter than accumulated', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  // Simulate streaming that over-shot the authoritative answer
  state.accumulatedText = 'The answer is 42. Extra hallucinated sentence.';
  state.flushedTextLength = 0;
  const handler = createConversationEventHandler(deps, state);

  handler({ type: 'final', finalText: 'The answer is 42.' } as any);

  // The guard `finalText.length > accumulatedText.length` is false when final is shorter.
  // accumulatedText is not corrected, so the hallucinated tail is included in the flush.
  t.is(deps.calls.appendedMessages.length, 1);
  const flushedMsg = deps.calls.appendedMessages[0][0];
  // Fails: actual is the full over-accumulated string including ' Extra hallucinated sentence.'
  t.is(flushedMsg.text, 'The answer is 42.');
});

// =============================================================================
// Bug: whitespace-only content before a paragraph boundary is permanently dropped
// =============================================================================

test('text_delta: whitespace-only content before first paragraph boundary is silently dropped', (t) => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // Response begins with whitespace before the paragraph boundary
  handler({ type: 'text_delta', delta: '   \n\nActual content' } as ConversationEvent);

  // flushedTextLength is NOT advanced — whitespace content is kept in the unflushed window
  t.is(state.flushedTextLength, 0);
  t.is(deps.calls.appendedMessages.length, 0);

  // The live updater only received 'Actual content' — the leading spaces are gone
  t.deepEqual(deps.calls.botResponsePushes, ['Actual content']);

  // After final, only 'Actual content' is written; the three leading spaces are permanently lost
  handler({ type: 'final', finalText: '   \n\nActual content' } as any);
  t.is(deps.calls.appendedMessages.length, 1);
  // Fails: actual is 'Actual content' — '   ' is not recoverable
  t.is(deps.calls.appendedMessages[0][0].text, '   \n\nActual content');
});

// =============================================================================
// Bug: command_message without callId leaves the running message stranded
// =============================================================================

test('command_message: leaves stale running message when no callId is present on either side', (t) => {
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
  t.is(runningMsg.status, 'running');
  t.is(runningMsg.callId, undefined);

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
  t.is(result.length, 1);
  t.is(result[0].status, 'completed');
});
