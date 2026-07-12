import { it, expect } from 'vitest';
import { createConversationEventHandler } from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import { createMockDeps } from './test-helpers/event-handler-fixtures.js';

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
    message: { toolName: 'glob', command: 'glob "*.ts"', success: true, output: '' },
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

it('subagent_tool_started does not downgrade a finished subagent row back to running', () => {
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
    type: 'subagent_completed',
    result: {
      agentId: 'agent-1',
      role: 'explorer',
      status: 'completed',
      finalText: 'done',
      filesChanged: [],
      toolsUsed: [],
    },
  } as ConversationEvent);

  handler({
    type: 'subagent_tool_started',
    agentId: 'agent-1',
    role: 'explorer',
    toolCallId: 'late-tool',
    toolName: 'grep',
    arguments: { pattern: 'TODO', path: 'src/' },
  } as any);

  const messagesAfterStart = deps.calls.appendedMessages[0];
  const messagesAfterCompletion = deps.calls.setMessagesCalls[0](messagesAfterStart);
  const messagesAfterLateTool = deps.calls.setMessagesCalls[1](messagesAfterCompletion);

  expect(messagesAfterLateTool[0]).toEqual({
    id: 'subagent-agent-1',
    sender: 'subagent',
    status: 'completed',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'investigate',
    tools: [],
    finalText: 'done',
  });
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

it('subagent_command_message: appends multiple tool calls of the same type instead of overwriting', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  // Start subagent
  handler({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'explorer',
    task: 'find files',
  } as ConversationEvent);

  // Run first read_file
  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: {
      id: 'cmd-1',
      sender: 'command',
      status: 'completed',
      command: 'read_file "file1.txt"',
      toolName: 'read_file',
      success: true,
    },
  } as any);

  // Run second read_file (same tool type)
  handler({
    type: 'subagent_command_message',
    agentId: 'agent-1',
    role: 'explorer',
    message: {
      id: 'cmd-2',
      sender: 'command',
      status: 'completed',
      command: 'read_file "file2.txt"',
      toolName: 'read_file',
      success: true,
    },
  } as any);

  let messages = deps.calls.appendedMessages[0];
  for (const update of deps.calls.setMessagesCalls) {
    messages = update(messages);
  }

  expect(messages[0].tools).toEqual(['read_file "file1.txt" (Success)', 'read_file "file2.txt" (Success)']);
});
