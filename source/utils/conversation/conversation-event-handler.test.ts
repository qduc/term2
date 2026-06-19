import { it, expect } from 'vitest';
import { createConversationEventHandler, type ConversationEventHandlerDeps } from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../../services/conversation/conversation-events.js';

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
// text_delta tests
// =============================================================================

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

// =============================================================================
// reasoning_delta tests
// =============================================================================

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

// =============================================================================
// tool_started tests
// =============================================================================

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

// =============================================================================
// command_message tests
// =============================================================================

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

// =============================================================================
// subagent activity tests
// =============================================================================

it('subagent events: maintains a live peek with the last three tools', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'inspect the command message rendering flow and report findings',
  } as ConversationEvent);

  expect(deps.calls.appendedMessages[0]).toEqual([
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
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: { toolName: 'find_files', command: 'find_files "*.ts"', success: true, output: '' },
  } as any);
  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: { toolName: 'grep', command: 'grep "needle" "source"', success: true, output: 'line1\nline2' },
  } as any);
  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: { toolName: 'read_file', command: 'read_file "source/app.tsx"', success: true, output: '' },
  } as any);
  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: {
      toolName: 'read_code_outline',
      command: 'read_code_outline "source/app.tsx"',
      success: true,
      output: '',
    },
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  expect(messages).toEqual([
    {
      id: 'subagent-agent-1',
      sender: 'subagent',
      status: 'running',
      agentId: 'agent-1',
      role: 'explorer',
      task: 'inspect the command message rendering flow and report findings',
      tools: [
        'grep "needle" "source" (2 matches)',
        'read_file "source/app.tsx" (Success)',
        'read_code_outline "source/app.tsx" (Success)',
      ],
    },
  ]);
});

it('subagent_completed updates the status of the live peek', () => {
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

  expect(result).toEqual([
    {
      id: 'subagent-agent-1',
      sender: 'subagent',
      status: 'completed',
      agentId: 'agent-1',
      role: 'worker',
      task: 'make the change',
      finalText: 'done',
      tools: ['apply_patch'],
    },
  ]);
});

it('subagent_started links callId from tool_started and command_message replaces it', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // 1. tool_started for run_subagent
  handler({
    type: 'tool_started',
    toolCallId: 'call-sa-123',
    toolName: 'run_subagent',
    arguments: { role: 'worker', task: 'do task X' },
  } as ConversationEvent);

  // 2. subagent_started
  handler({
    type: 'subagent_started',
    agentId: 'agent-sa-123',
    role: 'worker',
    task: 'do task X',
  } as ConversationEvent);

  expect(deps.calls.appendedMessages.length).toBe(1);
  const subagentMsg = deps.calls.appendedMessages[0][0];
  expect(subagentMsg.sender).toBe('subagent');
  expect(subagentMsg.callId).toBe('call-sa-123');

  // 3. subagent_completed updates status
  handler({
    type: 'subagent_completed',
    result: {
      agentId: 'agent-sa-123',
      role: 'worker',
      status: 'completed',
      finalText: 'done',
      filesChanged: [],
      toolsUsed: [],
    },
  } as ConversationEvent);

  // 4. command_message for run_subagent is now skipped (SubagentActivityMessage
  //    handles display), so no additional setMessages call is made.
  handler({
    type: 'command_message',
    message: {
      id: 'result-sa-123',
      sender: 'command',
      status: 'completed',
      command: 'run_subagent [worker] do task X',
      output: 'done',
      callId: 'call-sa-123',
      toolName: 'run_subagent',
    },
  } as ConversationEvent);

  // Only one setMessages call: from subagent_completed, not from command_message
  expect(deps.calls.setMessagesCalls.length).toBe(1);

  // The subagent message remains intact (not replaced by command message)
  const completedMsg = deps.calls.setMessagesCalls[0]!([subagentMsg]);
  expect(completedMsg.length).toBe(1);
  expect(completedMsg[0].sender).toBe('subagent');
  expect(completedMsg[0].status).toBe('completed');
});

// =============================================================================
// retry tests
// =============================================================================

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

// =============================================================================
// final event tests
// =============================================================================

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

// =============================================================================
// unknown event tests
// =============================================================================

it('unknown event: is ignored without error', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // Should not throw
  handler({ type: 'unknown_event' } as any);

  expect(deps.calls.appendedMessages.length).toBe(0);
  expect(deps.calls.setMessagesCalls.length).toBe(0);
});

// =============================================================================
// Bug: final event silently ignores corrections when finalText.length <= accumulatedText.length
// =============================================================================

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

// =============================================================================
// Whitespace preservation
// =============================================================================

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

// =============================================================================
// Bug: command_message without callId leaves the running message stranded
// =============================================================================

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

it('subagent_started: ignores event if parentTool is ask_mentor', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'mentor',
    task: 'peer review this plan',
    parentTool: 'ask_mentor',
  } as ConversationEvent);

  expect(deps.calls.appendedMessages.length).toBe(0);
});

it('subagent_command_message: replaces generic toolName or appends command to subagent tools', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // 1. Subagent starts
  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'investigate',
  } as ConversationEvent);

  // 2. Subagent tool starts (generic name 'read_file')
  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'read_file',
  } as any);

  // 3. Subagent command message received
  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: {
      id: 'cmd-1',
      sender: 'command',
      status: 'completed',
      command: 'read_file "source/app.tsx"',
      toolName: 'read_file',
      success: true,
    },
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  expect(messages).toEqual([
    {
      id: 'subagent-agent-1',
      sender: 'subagent',
      status: 'running',
      agentId: 'agent-1',
      role: 'explorer',
      task: 'investigate',
      tools: ['read_file "source/app.tsx" (Success)'],
    },
  ]);
});

it('subagent_command_message: creates subagent message if not present', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: {
      id: 'cmd-1',
      sender: 'command',
      status: 'completed',
      command: 'read_file "source/app.tsx"',
      toolName: 'read_file',
      success: true,
    },
  } as any);

  expect(deps.calls.setMessagesCalls.length).toBe(1);
  const result = deps.calls.setMessagesCalls[0]([]);
  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('subagent');
  expect(result[0].agentId).toBe('agent-1');
  expect(result[0].tools).toEqual(['read_file "source/app.tsx" (Success)']);
});

it('subagent_tool_started: formats shell command with args', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'investigate',
  } as ConversationEvent);

  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'shell',
    arguments: { command: 'npm test' },
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  expect(messages[0].tools).toEqual([]);
});

it('subagent_command_message: replaces formatted shell command and appends outcome', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'investigate',
  } as ConversationEvent);

  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'shell',
    arguments: { command: 'npm test' },
  } as any);

  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: {
      id: 'cmd-1',
      sender: 'command',
      status: 'completed',
      command: 'npm test',
      toolName: 'shell',
      success: false,
    },
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  expect(messages[0].tools).toEqual(['shell npm test (Failed)']);
});

it('subagent_command_message: counts matches for grep tool and appends count', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'investigate',
  } as ConversationEvent);

  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'grep',
    arguments: { pattern: 'TODO', path: 'src/' },
  } as any);

  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: {
      id: 'cmd-1',
      sender: 'command',
      status: 'completed',
      command: 'grep "TODO" "src/"',
      toolName: 'grep',
      output: 'src/main.ts:1:TODO: first\nsrc/main.ts:5:TODO: second',
    },
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  expect(messages[0].tools).toEqual(['grep "TODO" "src/" (2 matches)']);
});

it('subagent_command_message: appends 0 matches for empty grep output', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'investigate',
  } as ConversationEvent);

  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolName: 'grep',
    arguments: { pattern: 'TODO', path: 'src/' },
  } as any);

  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: {
      id: 'cmd-1',
      sender: 'command',
      status: 'completed',
      command: 'grep "TODO" "src/"',
      toolName: 'grep',
      output: 'No matches found.',
    },
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  expect(messages[0].tools).toEqual(['grep "TODO" "src/" (0 matches)']);
});

it('subagent_command_message: stores CommandMessage object for write tools', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'investigate',
  } as ConversationEvent);

  const writeMsg = {
    id: 'cmd-w1',
    sender: 'command' as const,
    status: 'completed' as const,
    command: 'create_file "src/test.txt"',
    toolName: 'create_file',
    toolArgs: { path: 'src/test.txt', content: 'hello' },
    success: true,
  };

  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: writeMsg,
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  expect(messages[0].tools.length).toBe(1);
  expect(messages[0].tools[0]).toEqual(writeMsg);
});

it('tool_started: renders parent tool call when a subagent is active', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'find x',
  } as any);
  handler({
    type: 'tool_started',
    toolCallId: 'call-shell-1',
    toolName: 'shell',
    arguments: { command: 'pwd' },
  } as any);

  expect(deps.calls.appendedMessages.length).toBe(2);
  expect(deps.calls.appendedMessages[1][0].callId).toBe('call-shell-1');
});

it('tool_started: renders parent tool call after local subagent activity', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'inspect',
  } as any);

  handler({
    type: 'tool_started',
    toolCallId: 'call-shell-1',
    toolName: 'shell',
    arguments: { command: 'pwd' },
  } as any);

  expect(deps.calls.appendedMessages.length).toBe(2);
  expect(deps.calls.appendedMessages[0][0].sender).toBe('subagent');
  expect(deps.calls.appendedMessages[1][0].callId).toBe('call-shell-1');
});

it('command_message: renders parent tool completion when subagent is active', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'find x',
  } as any);
  handler({
    type: 'command_message',
    message: {
      id: 'result-shell-1',
      sender: 'command',
      status: 'completed',
      command: 'pwd',
      output: '/home',
      callId: 'call-shell-1',
      toolName: 'shell',
    },
  } as any);

  expect(deps.calls.setMessagesCalls.length).toBe(1);
});

it('tool_started: links subagent delegation tools to subagent activity', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'tool_started',
    toolCallId: 'call-sa-nested',
    toolName: 'run_subagent_worker',
    arguments: { role: 'worker', task: 'nested work' },
  } as any);

  handler({
    type: 'subagent_started',
    agentId: 'agent-sa-nested',
    role: 'worker',
    task: 'nested work',
  } as any);

  expect(deps.calls.appendedMessages.length).toBe(1);
  expect(deps.calls.appendedMessages[0][0].id).toBe('subagent-agent-sa-nested');
  expect(deps.calls.appendedMessages[0][0].callId).toBe('call-sa-nested');
});
