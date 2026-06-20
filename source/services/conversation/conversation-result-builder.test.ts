import { it, expect, beforeEach, afterEach } from 'vitest';
import { buildConversationResult, toTerminalEvent } from './conversation-result-builder.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import { ApprovalState } from '../approval/approval-state.js';
import { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import { ConversationStore } from './conversation-store.js';
import { LoggingService } from '../logging/logging-service.js';
import type { AgentStream } from '../agent-stream.js';
import { clearToolFormatters, registerToolFormatters } from '../../tools/command-message-formatters.js';
import { formatShellCommandMessage } from '../../tools/system/shell.js';
import { clearApprovalRejectionMarkers } from '../../utils/streaming/extract-command-messages.js';
import { toolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';

beforeEach(() => {
  clearToolFormatters();
  registerToolFormatters([{ name: 'shell', formatCommandMessage: formatShellCommandMessage }]);
  clearApprovalRejectionMarkers();
  toolApprovalPolicyRegistry.clear();
});

afterEach(() => {
  clearToolFormatters();
  clearApprovalRejectionMarkers();
  toolApprovalPolicyRegistry.clear();
});

const logger = new LoggingService({ disableLogging: true });
const makeStream = (extras: any = {}): AgentStream =>
  ({
    [Symbol.asyncIterator]: async function* () {},
    completed: Promise.resolve(null),
    ...extras,
  } as any);

const makeDeps = (mode: 'off' | 'advisory' | 'auto' = 'off') => {
  const conversationStore = new ConversationStore();
  const agentClient: any = { chat: async () => '{"results":[]}' };
  const settingsService: any = {
    get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? (mode as unknown as T) : undefined),
  };
  const sessionContextService = {
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
    getContext: () => null,
  };
  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient,
    logger,
    settingsService,
    sessionContextService,
  });
  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
    toolTracker: { recordAbortedApproval: () => {}, export: () => [] } as any,
    generationGuard: { isCurrent: () => true } as any,
  });
  return { approvalFlow, shellAutoApproval, logger, sessionId: 's1' };
};

it('response outcome when stream has no interruptions', async () => {
  const stream = makeStream({
    finalOutput: 'Done.',
    history: [],
    newItems: [],
  });
  const outcome = await buildConversationResult(
    {
      result: stream,
      finalOutputOverride: 'Hello',
      toolCallArgumentsById: new Map(),
      emittedCommandIds: new Set(),
    },
    makeDeps(),
  );

  expect(outcome.kind).toBe('response');
  if (outcome.kind === 'response') {
    expect(outcome.result.finalText).toBe('Hello');
    expect(outcome.result.commandMessages).toEqual([]);
  }
});

it('response outcome uses completed final output when it extends streamed output', async () => {
  const stream = makeStream({
    finalOutput: 'Intro\n\n## Missing Header\n\nBody',
    history: [],
    newItems: [],
  });
  const outcome = await buildConversationResult(
    {
      result: stream,
      finalOutputOverride: 'Intro\n\n',
      toolCallArgumentsById: new Map(),
      emittedCommandIds: new Set(),
    },
    makeDeps(),
  );

  expect(outcome.kind).toBe('response');
  if (outcome.kind === 'response') {
    expect(outcome.result.finalText).toBe('Intro\n\n## Missing Header\n\nBody');
  }
});

it('response outcome uses completed final output when it corrects streamed text with the same length', async () => {
  const stream = makeStream({
    finalOutput: 'Hello world',
    history: [],
    newItems: [],
  });
  const outcome = await buildConversationResult(
    {
      result: stream,
      finalOutputOverride: 'Hello wrold',
      toolCallArgumentsById: new Map(),
      emittedCommandIds: new Set(),
    },
    makeDeps(),
  );

  expect(outcome.kind).toBe('response');
  if (outcome.kind === 'response') {
    expect(outcome.result.finalText).toBe('Hello world');
  }
});

it('response outcome uses completed final output when it shortens streamed text', async () => {
  const stream = makeStream({
    finalOutput: 'The answer is 42.',
    history: [],
    newItems: [],
  });
  const outcome = await buildConversationResult(
    {
      result: stream,
      finalOutputOverride: 'The answer is 42. Extra hallucinated sentence.',
      toolCallArgumentsById: new Map(),
      emittedCommandIds: new Set(),
    },
    makeDeps(),
  );

  expect(outcome.kind).toBe('response');
  if (outcome.kind === 'response') {
    expect(outcome.result.finalText).toBe('The answer is 42.');
  }
});

it('approval_required outcome when stream has interruptions', async () => {
  const stream = makeStream({
    interruptions: [
      {
        name: 'shell',
        callId: 'c1',
        arguments: { command: 'ls' },
        agent: { name: 'TestAgent' },
      },
    ],
    state: { id: 'state-1' },
  });
  const outcome = await buildConversationResult({ result: stream, toolCallArgumentsById: new Map() }, makeDeps('off'));

  expect(outcome.kind).toBe('approval_required');
  if (outcome.kind === 'approval_required') {
    expect(outcome.result.approval.toolName).toBe('shell');
    expect(outcome.result.approval.callId).toBe('c1');
    expect(outcome.result.approval.agentName).toBe('TestAgent');
  }
});

it('auto_approve outcome for valid read-only interruptions registered with the policy registry', async () => {
  toolApprovalPolicyRegistry.register({
    toolName: 'read_file',
    needsApproval: async () => false,
  });
  const stream = makeStream({
    interruptions: [
      {
        name: 'read_file',
        callId: 'read-1',
        arguments: { path: 'README.md' },
        agent: { name: 'TestAgent' },
      },
    ],
    state: { id: 'state-1' },
  });

  const outcome = await buildConversationResult({ result: stream, toolCallArgumentsById: new Map() }, makeDeps('off'));

  expect(outcome.kind).toBe('auto_approve');
  if (outcome.kind === 'auto_approve') {
    expect(outcome.callId).toBe('read-1');
    expect(outcome.advisory).toBeUndefined();
  }
});

it('approval_required records the matching nested subagent owner', async () => {
  const deps = makeDeps('off');
  const stream = makeStream({
    interruptions: [
      {
        name: 'shell',
        callId: 'nested-shell-call',
        arguments: { command: 'touch nested.txt' },
        agent: { name: 'Worker' },
      },
    ],
    state: {
      _pendingAgentToolRuns: new Map([
        [
          'run_subagent:parent-call',
          JSON.stringify({
            context: { context: { agentId: 'worker-1', role: 'worker' } },
            currentStep: {
              type: 'next_step_interruption',
              data: { interruptions: [{ callId: 'nested-shell-call' }] },
            },
          }),
        ],
      ]),
    },
  });

  const outcome = await buildConversationResult({ result: stream, toolCallArgumentsById: new Map() }, deps);

  expect(outcome.kind).toBe('approval_required');
  expect(deps.approvalFlow.getPending()?.owner).toEqual({
    kind: 'subagent',
    agentId: 'worker-1',
    role: 'worker',
  });
});

it('approval_required matches the correct owner when multiple subagents are pending', async () => {
  const deps = makeDeps('off');
  const nestedState = (agentId: string, role: string, callId: string) =>
    JSON.stringify({
      context: { context: { agentId, role } },
      currentStep: {
        type: 'next_step_interruption',
        data: { interruptions: [{ callId }] },
      },
    });
  const stream = makeStream({
    interruptions: [
      {
        name: 'shell',
        callId: 'target-call',
        arguments: { command: 'pwd' },
        agent: { name: 'Worker' },
      },
    ],
    state: {
      _pendingAgentToolRuns: new Map([
        ['run_subagent:first', nestedState('worker-1', 'worker', 'other-call')],
        ['run_subagent:second', nestedState('explorer-1', 'explorer', 'target-call')],
      ]),
    },
  });

  await buildConversationResult({ result: stream, toolCallArgumentsById: new Map() }, deps);

  expect(deps.approvalFlow.getPending()?.owner).toEqual({
    kind: 'subagent',
    agentId: 'explorer-1',
    role: 'explorer',
  });
});

it('approval_required defaults to parent owner for malformed nested state', async () => {
  const deps = makeDeps('off');
  const stream = makeStream({
    interruptions: [
      {
        name: 'shell',
        callId: 'parent-call',
        arguments: { command: 'pwd' },
        agent: { name: 'CLI Agent' },
      },
    ],
    state: {
      _pendingAgentToolRuns: new Map([['run_subagent:broken', '{invalid-json']]),
    },
  });

  await buildConversationResult({ result: stream, toolCallArgumentsById: new Map() }, deps);

  expect(deps.approvalFlow.getPending()?.owner).toEqual({ kind: 'parent' });
});

it('approval_required outcome preserves usage from model turn', async () => {
  const stream = makeStream({
    interruptions: [
      {
        name: 'shell',
        callId: 'call-usage',
        arguments: { command: 'ls' },
        agent: { name: 'TestAgent' },
      },
    ],
    state: { id: 'state-usage' },
  });
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  const outcome = await buildConversationResult(
    { result: stream, usage, toolCallArgumentsById: new Map() },
    makeDeps(),
  );

  expect(outcome.kind).toBe('approval_required');
  if (outcome.kind === 'approval_required') {
    expect(outcome.result.usage).toEqual(usage);
  }
});

it('auto_approve outcome when LLM advises approval and mode=auto', async () => {
  const stream = makeStream({
    interruptions: [
      {
        name: 'shell',
        callId: 'c1',
        arguments: { command: 'ls' },
      },
    ],
    state: {},
  });
  const conversationStore = new ConversationStore();
  const agentClient: any = {
    chat: async () => '{"results":[{"id":"c1","reasoning":"safe","approved":true}]}',
  };
  const settingsService: any = {
    get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? ('auto' as unknown as T) : undefined),
  };
  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient,
    logger,
    settingsService,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });
  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
    toolTracker: { recordAbortedApproval: () => {}, export: () => [] } as any,
    generationGuard: { isCurrent: () => true } as any,
  });
  const outcome = await buildConversationResult(
    { result: stream, toolCallArgumentsById: new Map() },
    { approvalFlow, shellAutoApproval, logger, sessionId: 's1' },
  );

  expect(outcome.kind).toBe('auto_approve');
  if (outcome.kind === 'auto_approve') {
    expect(outcome.callId).toBe('c1');
    expect(outcome.argumentsText).toBe('ls');
    expect(outcome.advisory?.approved).toBe(true);
  }
});

it('command messages dedup against emittedCommandIds', async () => {
  const stream = makeStream({
    history: [
      { type: 'function_call_output', call_id: 'a', output: '{"text":"x","metadata":{"messageId":"m-a"}}' },
      { type: 'function_call_output', call_id: 'b', output: '{"text":"y","metadata":{"messageId":"m-b"}}' },
    ],
  });
  const outcome = await buildConversationResult(
    {
      result: stream,
      emittedCommandIds: new Set(['m-a']),
      toolCallArgumentsById: new Map(),
    },
    makeDeps(),
  );

  expect(outcome.kind).toBe('response');
  if (outcome.kind === 'response') {
    const ids = (outcome.result.commandMessages ?? []).map((m) => m.id);
    expect(ids.includes('m-a')).toBe(false);
  }
});

it('response outcome derives turnItems from provider items with metadata and reasoning ordering', async () => {
  const stream = makeStream({
    history: [],
    newItems: [
      {
        type: 'function_call',
        id: 'fc_1',
        callId: 'call-1',
        name: 'shell',
        arguments: '{"command":"date"}',
        providerData: {
          reasoning_content: 'I should run date.',
          reasoning_details: [{ type: 'summary_text', text: 'I should run date.' }],
        },
      },
      {
        type: 'function_call_result',
        id: 'fr_1',
        callId: 'call-1',
        name: 'shell',
        output: 'Mon Jan 01 00:00:00 UTC 2024',
      },
      {
        role: 'assistant',
        type: 'message',
        id: 'msg_1',
        content: [{ type: 'output_text', text: 'Done.' }],
        providerData: {
          reasoning_content: 'Final reflection.',
          reasoning_details: [{ type: 'summary_text', text: 'Final reflection.' }],
        },
      },
    ],
  });

  const outcome = await buildConversationResult(
    {
      result: stream,
      toolCallArgumentsById: new Map(),
      emittedCommandIds: new Set(),
    },
    makeDeps(),
  );

  expect(outcome.kind).toBe('response');
  if (outcome.kind === 'response') {
    expect(outcome.result.turnItems).toEqual([
      {
        type: 'reasoning',
        text: 'I should run date.',
        providerMetadata: {
          reasoning_content: 'I should run date.',
          reasoning_details: [{ type: 'summary_text', text: 'I should run date.' }],
        },
      },
      {
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'shell',
        arguments: '{"command":"date"}',
        providerItem: {
          type: 'function_call',
          id: 'fc_1',
          callId: 'call-1',
          name: 'shell',
          arguments: '{"command":"date"}',
          providerData: {
            reasoning_content: 'I should run date.',
            reasoning_details: [{ type: 'summary_text', text: 'I should run date.' }],
          },
        },
      },
      {
        type: 'tool_result',
        callId: 'call-1',
        toolName: 'shell',
        status: 'completed',
        output: 'Mon Jan 01 00:00:00 UTC 2024',
        providerItem: {
          type: 'function_call_result',
          id: 'fr_1',
          callId: 'call-1',
          name: 'shell',
          output: 'Mon Jan 01 00:00:00 UTC 2024',
        },
      },
      {
        type: 'reasoning',
        text: 'Final reflection.',
        providerMetadata: {
          reasoning_content: 'Final reflection.',
          reasoning_details: [{ type: 'summary_text', text: 'Final reflection.' }],
        },
      },
      {
        type: 'assistant_text',
        text: 'Done.',
        providerMetadata: {
          reasoning_content: 'Final reflection.',
          reasoning_details: [{ type: 'summary_text', text: 'Final reflection.' }],
        },
        providerItemId: 'msg_1',
      },
    ]);
  }
});

it('toTerminalEvent shapes response into final event', () => {
  const event = toTerminalEvent({
    type: 'response',
    commandMessages: [],
    finalText: 'Done',
  });
  expect(event.type).toBe('final');
  if (event.type === 'final') {
    expect(event.finalText).toBe('Done');
  }
});

it('toTerminalEvent shapes approval_required with optional fields', () => {
  const event = toTerminalEvent({
    type: 'approval_required',
    approval: {
      agentName: 'A',
      toolName: 'shell',
      argumentsText: 'ls',
      callId: 'c1',
      rawInterruption: { name: 'shell' },
    },
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
  expect(event.type).toBe('approval_required');
  if (event.type === 'approval_required') {
    expect(event.approval.callId).toBe('c1');
    expect(event.approval.toolName).toBe('shell');
    expect(event.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  }
});

it('response outcome preserves approval-rejected command messages for rendering', async () => {
  // Regression test: when shell approval is denied, the command message with the rejection
  // message must still appear in commandMessages so the UI can render it.
  // Previously these were filtered out silently, leaving the user without feedback.
  // Simulate that approval-flow-coordinator marked call-1 as rejected (happens before buildConversationResult).
  const { markToolCallAsApprovalRejection } = await import('../../utils/streaming/extract-command-messages.js');
  markToolCallAsApprovalRejection('call-1');

  // A model turn carries command items in newItems (not history), so mirror that shape.
  const stream = makeStream({
    newItems: [
      {
        rawItem: {
          type: 'function_call',
          id: 'fc-1',
          callId: 'call-1',
          name: 'shell',
          arguments: JSON.stringify({ command: 'rm -rf /dangerous' }),
        },
      },
      {
        rawItem: {
          type: 'function_call_output',
          id: 'fco-1',
          callId: 'call-1',
          name: 'shell',
          output: "Tool execution was not approved. User's reason: too risky",
        },
      },
    ],
  });
  const outcome = await buildConversationResult({ result: stream, toolCallArgumentsById: new Map() }, makeDeps());

  expect(outcome.kind).toBe('response');
  if (outcome.kind === 'response') {
    // Previously this assertion would fail because isApprovalRejection messages were filtered out.
    expect((outcome.result.commandMessages ?? []).length).toBeGreaterThan(0);
    const rejectedMsg = (outcome.result.commandMessages ?? []).find((m) => m.isApprovalRejection);
    expect(rejectedMsg).toBeTruthy();
    expect(rejectedMsg!.toolName).toBe('shell');
    expect(rejectedMsg!.output.includes('not approved')).toBe(true);
  }
});

it('buildConversationResult and toTerminalEvent preserve turnItems', async () => {
  const stream = makeStream({
    finalOutput: 'Done.',
    history: [],
    newItems: [],
  });
  const turnItems = [
    { type: 'reasoning' as const, text: 'Thinking' },
    { type: 'assistant_text' as const, text: 'Done.' },
  ];
  const outcome = await buildConversationResult(
    {
      result: stream,
      toolCallArgumentsById: new Map(),
      turnItems,
    },
    makeDeps(),
  );

  expect(outcome.kind).toBe('response');
  if (outcome.kind === 'response') {
    expect(outcome.result.turnItems).toEqual(turnItems);

    const event = toTerminalEvent(outcome.result);
    expect(event.type).toBe('final');
    if (event.type === 'final') {
      expect(event.turnItems).toEqual(turnItems);
    }
  }
});
