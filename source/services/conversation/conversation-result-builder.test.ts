import test from 'ava';
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

test.beforeEach(() => {
  clearToolFormatters();
  registerToolFormatters([{ name: 'shell', formatCommandMessage: formatShellCommandMessage }]);
  clearApprovalRejectionMarkers();
});

test.afterEach(() => {
  clearToolFormatters();
  clearApprovalRejectionMarkers();
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

test('response outcome when stream has no interruptions', async (t) => {
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

  t.is(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    t.is(outcome.result.finalText, 'Hello');
    t.deepEqual(outcome.result.commandMessages, []);
  }
});

test('response outcome uses completed final output when it extends streamed output', async (t) => {
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

  t.is(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    t.is(outcome.result.finalText, 'Intro\n\n## Missing Header\n\nBody');
  }
});

test('response outcome uses completed final output when it corrects streamed text with the same length', async (t) => {
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

  t.is(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    t.is(outcome.result.finalText, 'Hello world');
  }
});

test('response outcome uses completed final output when it shortens streamed text', async (t) => {
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

  t.is(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    t.is(outcome.result.finalText, 'The answer is 42.');
  }
});

test('approval_required outcome when stream has interruptions', async (t) => {
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

  t.is(outcome.kind, 'approval_required');
  if (outcome.kind === 'approval_required') {
    t.is(outcome.result.approval.toolName, 'shell');
    t.is(outcome.result.approval.callId, 'c1');
    t.is(outcome.result.approval.agentName, 'TestAgent');
  }
});

test('approval_required records the matching nested subagent owner', async (t) => {
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

  t.is(outcome.kind, 'approval_required');
  t.deepEqual(deps.approvalFlow.getPending()?.owner, {
    kind: 'subagent',
    agentId: 'worker-1',
    role: 'worker',
  });
});

test('approval_required matches the correct owner when multiple subagents are pending', async (t) => {
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

  t.deepEqual(deps.approvalFlow.getPending()?.owner, {
    kind: 'subagent',
    agentId: 'explorer-1',
    role: 'explorer',
  });
});

test('approval_required defaults to parent owner for malformed nested state', async (t) => {
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

  t.deepEqual(deps.approvalFlow.getPending()?.owner, { kind: 'parent' });
});

test('approval_required outcome preserves usage from model turn', async (t) => {
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

  t.is(outcome.kind, 'approval_required');
  if (outcome.kind === 'approval_required') {
    t.deepEqual(outcome.result.usage, usage);
  }
});

test('auto_approve outcome when LLM advises approval and mode=auto', async (t) => {
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

  t.is(outcome.kind, 'auto_approve');
  if (outcome.kind === 'auto_approve') {
    t.is(outcome.callId, 'c1');
    t.is(outcome.argumentsText, 'ls');
    t.is(outcome.advisory.approved, true);
  }
});

test('command messages dedup against emittedCommandIds', async (t) => {
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

  t.is(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    const ids = (outcome.result.commandMessages ?? []).map((m) => m.id);
    t.false(ids.includes('m-a'));
  }
});

test('response outcome derives turnItems from provider items with metadata and reasoning ordering', async (t) => {
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

  t.is(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    t.deepEqual(outcome.result.turnItems, [
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

test('toTerminalEvent shapes response into final event', (t) => {
  const event = toTerminalEvent({
    type: 'response',
    commandMessages: [],
    finalText: 'Done',
  });
  t.is(event.type, 'final');
  if (event.type === 'final') {
    t.is(event.finalText, 'Done');
  }
});

test('toTerminalEvent shapes approval_required with optional fields', (t) => {
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
  t.is(event.type, 'approval_required');
  if (event.type === 'approval_required') {
    t.is(event.approval.callId, 'c1');
    t.is(event.approval.toolName, 'shell');
    t.deepEqual(event.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  }
});

test('response outcome preserves approval-rejected command messages for rendering', async (t) => {
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

  t.is(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    // Previously this assertion would fail because isApprovalRejection messages were filtered out.
    t.true(
      (outcome.result.commandMessages ?? []).length > 0,
      'Expected at least one command message to be preserved after approval rejection',
    );
    const rejectedMsg = (outcome.result.commandMessages ?? []).find((m) => m.isApprovalRejection);
    t.truthy(rejectedMsg, 'Expected a command message with isApprovalRejection=true');
    t.is(rejectedMsg!.toolName, 'shell', 'Expected toolName to be preserved for shell command');
    t.true(
      rejectedMsg!.output.includes('not approved'),
      'Expected rejection message in output, but got: ' + rejectedMsg!.output,
    );
  }
});

test('buildConversationResult and toTerminalEvent preserve turnItems', async (t) => {
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

  t.is(outcome.kind, 'response');
  if (outcome.kind === 'response') {
    t.deepEqual(outcome.result.turnItems, turnItems);

    const event = toTerminalEvent(outcome.result);
    t.is(event.type, 'final');
    if (event.type === 'final') {
      t.deepEqual(event.turnItems, turnItems);
    }
  }
});
