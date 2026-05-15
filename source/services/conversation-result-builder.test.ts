import test from 'ava';
import { buildConversationResult, toTerminalEvent } from './conversation-result-builder.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { ApprovalState } from './approval-state.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { ConversationStore } from './conversation-store.js';
import { LoggingService } from './logging-service.js';
import type { AgentStream } from './agent-stream.js';

const logger = new LoggingService({ disableLogging: true });

const makeStream = (extras: Partial<AgentStream> = {}): AgentStream =>
  ({
    [Symbol.asyncIterator]: async function* () {},
    completed: Promise.resolve(null),
    ...extras,
  } as AgentStream);

const makeDeps = (mode: 'off' | 'advisory' | 'auto' = 'off') => {
  const conversationStore = new ConversationStore();
  const agentClient: any = { chat: async () => '{"results":[]}' };
  const settingsService: any = {
    get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? (mode as unknown as T) : undefined),
  };
  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient,
    logger,
    settingsService,
  });
  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
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
  });
  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
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
  });
  t.is(event.type, 'approval_required');
  if (event.type === 'approval_required') {
    t.is(event.approval.callId, 'c1');
    t.is(event.approval.toolName, 'shell');
  }
});
