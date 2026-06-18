import { it, expect, beforeAll, beforeEach } from 'vitest';
import { ConversationService } from './conversation-service.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationTerminal, FinalTerminal, ApprovalRequiredTerminal } from '../../contracts/conversation.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  clearApprovalRejectionMarkers,
  markToolCallAsApprovalRejection,
} from '../../utils/streaming/extract-command-messages.js';
import { registerToolFormatters } from '../../tools/command-message-formatters.js';
import { formatShellCommandMessage } from '../../tools/system/shell.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: (): string | undefined => undefined,
  clearCorrelationId: () => {},
};

const sessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T): T => fn(),
  getContext: () => null,
};

/**
 * Creates a partial ConversationAgentClient with safe no-op defaults.
 * Pass only the methods the test actually exercises.
 */
function partialClient(methods: Record<string, unknown> = {}): ConversationAgentClient {
  return {
    chat: async () => '',
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    startStream: async () => new MockStream([]) as unknown as AgentStream,
    continueRunStream: async () => new MockStream([]) as unknown as AgentStream,
    ...methods,
  } as ConversationAgentClient;
}

function asFinal(result: ConversationTerminal): FinalTerminal {
  if (result.type !== 'response') throw new Error('Expected FinalTerminal');
  return result;
}

function asApproval(result: ConversationTerminal): ApprovalRequiredTerminal {
  if (result.type !== 'approval_required') throw new Error('Expected ApprovalRequiredTerminal');
  return result;
}

beforeAll(() => {
  registerToolFormatters([{ name: 'shell', formatCommandMessage: formatShellCommandMessage }]);
});

beforeEach(() => {
  clearApprovalRejectionMarkers();
});

it('emits live text chunks for response.output_text.delta events', async () => {
  expect.assertions(3);

  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
  ];

  const mockClient = partialClient({
    async startStream() {
      return new MockStream(events);
    },
  });

  const chunks: any[] = [];
  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('hi', {
    onTextChunk(full, chunk) {
      chunks.push({ full, chunk });
    },
  });

  expect(chunks).toEqual([
    { full: 'Hello', chunk: 'Hello' },
    { full: 'Hello world', chunk: ' world' },
  ]);
  expect(result.type).toBe('response');
  expect(asFinal(result).finalText).toBe('Hello world');
});

it('emits ConversationEvents (text_delta → final) in order', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
  ];

  const mockClient = partialClient({
    async startStream() {
      return new MockStream(events);
    },
  });

  const emitted: any[] = [];
  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('hi', {
    onEvent(event) {
      emitted.push(event);
    },
  });

  expect(result.type).toBe('response');
  expect(asFinal(result).finalText).toBe('Hello world');
  expect(emitted.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'final']);
});

it('emits approval_required ConversationEvent for interruptions', async () => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-xyz',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];

  const mockClient = partialClient({
    async startStream() {
      return initialStream;
    },
  });

  const emitted: any[] = [];
  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('run command', {
    onEvent(event) {
      emitted.push(event);
    },
  });

  expect(result.type).toBe('approval_required');
  expect(asApproval(result).approval.callId).toBe('call-xyz');
  expect(emitted.length).toBe(1);
  expect(emitted[0].type).toBe('approval_required');
  expect(emitted[0].approval.toolName).toBe('bash');
  expect(emitted[0].approval.argumentsText).toBe('echo hi');
  expect(emitted[0].approval.callId).toBe('call-xyz');
});

it('compacts whitespace-heavy JSON arguments for approvals', async () => {
  const interruption = {
    name: 'apply_patch',
    agent: { name: 'CLI Agent' },
    arguments: '{"path":"a.txt","timeout_ms":   \n\t\t    null,"max_output_length":\n\t null}',
    callId: 'call-trim',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];

  const mockClient = partialClient({
    async startStream() {
      return initialStream;
    },
  });

  const emitted: any[] = [];
  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('run tool', {
    onEvent(event) {
      emitted.push(event);
    },
  });

  expect(result.type).toBe('approval_required');
  expect(emitted.length).toBe(1);
  expect(emitted[0].type).toBe('approval_required');
  expect(emitted[0].approval.argumentsText).toBe('{"path":"a.txt","timeout_ms":null,"max_output_length":null}');
});

it('emits events when resolving aborted approval on next message', async () => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-abort',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approveCalls: [],
    rejectCalls: [],
    approve(arg: unknown) {
      (this as any).approveCalls.push(arg);
    },
    reject(arg: unknown) {
      (this as any).rejectCalls.push(arg);
    },
  };

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'After abort' }]);
  continuationStream.finalOutput = 'After abort';

  let interceptorCount = 0;
  const mockClient = partialClient({
    abort() {},
    addToolInterceptor() {
      interceptorCount++;
      return () => {
        interceptorCount--;
      };
    },
    async startStream() {
      return initialStream;
    },
    async continueRunStream(state: any, options: any) {
      expect(state).toBe(initialStream.state);
      expect(options).toEqual({
        previousResponseId: 'resp_test',
        sessionId: 'default',
        toolResultCallIds: ['call-abort'],
      });
      return continuationStream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  const approvalEvents: any[] = [];
  const approvalResult = await service.sendMessage('run command', {
    onEvent(event) {
      approvalEvents.push(event);
    },
  });
  expect(approvalResult.type).toBe('approval_required');
  expect(approvalEvents[0].type).toBe('approval_required');

  service.abort();

  const resolvedEvents: any[] = [];
  const resolvedResult = await service.sendMessage('new input', {
    onEvent(event) {
      resolvedEvents.push(event);
    },
  });

  expect(resolvedResult.type).toBe('response');
  expect(asFinal(resolvedResult).finalText).toBe('After abort');
  expect(resolvedEvents.some((e) => e.type === 'text_delta')).toBe(true);
  expect(resolvedEvents.some((e) => e.type === 'final')).toBe(true);
  expect(interceptorCount).toBe(0);
  expect(initialStream.state.approveCalls).toEqual([]);
  expect(initialStream.state.rejectCalls).toEqual([interruption]);
});

it('reject with reason and abort+new input yield the same history', async () => {
  const baseHistory = [
    {
      role: 'user',
      type: 'message',
      content: 'run command',
    },
    {
      type: 'function_call',
      name: 'shell',
      arguments: JSON.stringify({ command: 'echo hi' }),
      callId: 'call-1',
    },
  ];
  const rejectionHistory = [
    ...baseHistory,
    {
      type: 'tool_call_output_item',
      name: 'shell',
      output: 'Tool execution was not approved.',
      callId: 'call-1',
    },
  ];

  const runFlow = async (mode: string) => {
    const interruption = {
      name: 'shell',
      agent: { name: 'CLI Agent' },
      arguments: JSON.stringify({ command: 'echo hi' }),
      callId: 'call-1',
    };

    const initialStream = new MockStream([]);
    initialStream.interruptions = [interruption];
    initialStream.state = {
      approveCalls: [],
      rejectCalls: [],
      approve(arg: unknown) {
        (this as any).approveCalls.push(arg);
      },
      reject(arg: unknown) {
        (this as any).rejectCalls.push(arg);
      },
    };
    initialStream.history = baseHistory;

    const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Rejected' }]);
    continuationStream.finalOutput = 'Rejected';
    continuationStream.history = rejectionHistory;

    const nextStream = new MockStream([]);
    nextStream.finalOutput = 'Next';

    const startCalls: any[] = [];
    const mockClient = partialClient({
      getProvider() {
        return 'openrouter';
      },
      addToolInterceptor() {
        return () => {};
      },
      abort() {},
      async startStream(input: any, options: any) {
        startCalls.push({ input, options });
        if (startCalls.length === 1) return initialStream;
        return nextStream;
      },
      async continueRunStream() {
        return continuationStream;
      },
    });

    const service = new ConversationService({
      agentClient: mockClient,
      deps: { logger: mockLogger, sessionContextService },
    });

    const approvalResult = await service.sendMessage('run command');
    expect(approvalResult.type).toBe('approval_required');

    if (mode === 'reject') {
      await service.handleApprovalDecision('n', 'no thanks');
    } else {
      service.abort();
      await service.sendMessage('new input');
    }

    await service.sendMessage('next');

    expect(startCalls.length).toBe(2);
    return startCalls[1].input;
  };

  const rejectionHistoryAfter = await runFlow('reject');
  const abortHistoryAfter = await runFlow('abort');

  expect(abortHistoryAfter).toEqual(rejectionHistoryAfter);
});

it('passes previous response ids into subsequent runs', async () => {
  const streams = [new MockStream([]), new MockStream([])];
  streams[0].lastResponseId = 'resp-1';
  streams[0].finalOutput = 'First run done.';
  streams[1].lastResponseId = 'resp-2';
  streams[1].finalOutput = 'Second run done.';

  const startCalls: any[] = [];
  const mockClient = partialClient({
    async startStream(text: any, options: any) {
      const index = startCalls.length;
      startCalls.push({ text, options });
      return streams[index];
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  await service.sendMessage('first');
  const secondResult = await service.sendMessage('second');

  expect(startCalls).toEqual([
    { text: 'first', options: { previousResponseId: null, sessionId: 'default' } },
    { text: 'second', options: { previousResponseId: 'resp-1', sessionId: 'default' } },
  ]);
  expect(secondResult.type).toBe('response');
  expect(asFinal(secondResult).finalText).toBe('Second run done.');
});

it('emits approval interruptions and resumes after approval', async () => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approveCalls: [],
    rejectCalls: [],
    approve(arg: unknown) {
      (this as any).approveCalls.push(arg);
    },
    reject(arg: unknown) {
      (this as any).rejectCalls.push(arg);
    },
  };

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved run' }]);
  continuationStream.finalOutput = 'Approved run';

  const mockClient = partialClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream(state: any, options: any) {
      expect(state).toBe(initialStream.state);
      expect(options).toEqual({
        previousResponseId: 'resp_test',
        sessionId: 'default',
        toolResultCallIds: [],
      });
      return continuationStream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const approvalResult = await service.sendMessage('run command');
  expect(approvalResult.type).toBe('approval_required');
  expect(asApproval(approvalResult).approval.toolName).toBe('bash');
  expect(asApproval(approvalResult).approval.argumentsText).toBe('echo hi');

  const finalResult = await service.handleApprovalDecision('y');
  expect(finalResult).toBeTruthy();
  expect(finalResult!.type).toBe('response');
  expect(asFinal(finalResult!).finalText).toBe('Approved run');
  expect(initialStream.state.approveCalls).toEqual([interruption]);
  expect(initialStream.state.rejectCalls).toEqual([]);
});

it('dedupes command messages emitted live from run events', async () => {
  const commandPayload = 'exit 0\nfile.txt';
  const rawItem = {
    id: 'call-123',
    type: 'function_call_result',
    name: 'shell',
    arguments: JSON.stringify({ commands: 'ls' }),
  };
  const commandItem = {
    type: 'tool_call_output_item',
    name: 'shell',
    output: commandPayload,
    rawItem,
  };
  const events = [{ type: 'run_item_stream_event', item: commandItem }];
  const stream = new MockStream(events);
  stream.newItems = [commandItem];

  const emitted: any[] = [];
  const mockClient = partialClient({
    async startStream() {
      return stream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('run shell', {
    onCommandMessage(message) {
      emitted.push(message);
    },
  });

  expect(emitted).toEqual([
    {
      id: 'call-123-0',
      callId: 'call-123',
      sender: 'command',
      status: 'completed',
      command: 'ls',
      output: 'file.txt',
      success: true,
      isApprovalRejection: false,
      failureReason: undefined,
      toolName: 'shell',
    },
  ]);
  expect(asFinal(result).commandMessages).toEqual([]);
});

it('attaches cached shell args when output uses call_id', async () => {
  const functionCallItem = {
    rawItem: {
      type: 'function_call',
      id: 'call-abc',
      name: 'shell',
      arguments: JSON.stringify({ command: 'npm run lint' }),
    },
  };

  const outputItem = {
    type: 'tool_call_output_item',
    name: 'shell',
    output: 'exit 0\n> md-preview@0.0.0 lint\n> eslint .',
    rawItem: {
      type: 'function_call_result',
      name: 'shell',
      id: 'result-1',
      call_id: 'call-abc',
    },
  };

  const events = [
    { type: 'run_item_stream_event', item: functionCallItem },
    { type: 'run_item_stream_event', item: outputItem },
  ];
  const stream = new MockStream(events);
  stream.newItems = [functionCallItem, outputItem];

  const emitted: any[] = [];
  const mockClient = partialClient({
    async startStream() {
      return stream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('run shell', {
    onCommandMessage(message) {
      emitted.push(message);
    },
  });

  expect(emitted).toEqual([
    {
      id: 'result-1-0',
      callId: 'call-abc',
      sender: 'command',
      status: 'completed',
      command: 'npm run lint',
      output: '> md-preview@0.0.0 lint\n> eslint .',
      success: true,
      isApprovalRejection: false,
      failureReason: undefined,
      toolName: 'shell',
    },
  ]);
  expect(asFinal(result).commandMessages).toEqual([]);
});

it('preserves approval rejection command messages', async () => {
  const rejectionPayload = JSON.stringify({
    output: [
      {
        command: 'should-not-show',
        stdout: 'fake output',
        stderr: '',
        outcome: { type: 'exit', exitCode: 1 },
      },
    ],
  });
  const rawItem = {
    id: 'rejection-call',
    callId: 'rejection-call',
    type: 'function_call_result',
    name: 'shell',
    arguments: JSON.stringify({ commands: ['should-not-show'] }),
  };
  markToolCallAsApprovalRejection(rawItem.callId);
  const commandItem = {
    type: 'tool_call_output_item',
    name: 'shell',
    output: rejectionPayload,
    rawItem,
  };
  const events = [{ type: 'run_item_stream_event', item: commandItem }];
  const stream = new MockStream(events);
  stream.newItems = [commandItem];

  const emitted: any[] = [];
  const mockClient = partialClient({
    async startStream() {
      return stream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('run shell', {
    onCommandMessage(message) {
      emitted.push(message);
    },
  });

  expect(emitted.length).toBe(1);
  expect(emitted[0].isApprovalRejection).toBe(true);
  expect(emitted[0].command).toBe('should-not-show');
  expect(emitted[0].output).toBe(rejectionPayload);
  expect(asFinal(result).commandMessages).toEqual([]);
});

it('dedupes commands from initial stream when continuation history contains them', async () => {
  // This test simulates the scenario where:
  // 1. Initial stream emits command 'ls' before hitting an approval interruption
  // 2. User approves, continuation stream runs
  // 3. Continuation stream's history/newItems contains the 'ls' command again
  // The 'ls' command should NOT be duplicated in the final result

  const lsCommandPayload = 'exit 0\nfile.txt';
  const lsRawItem = {
    id: 'call-ls-123',
    type: 'function_call_result',
    name: 'shell',
    arguments: JSON.stringify({ commands: 'ls' }),
  };
  const lsCommandItem = {
    type: 'tool_call_output_item',
    name: 'shell',
    output: lsCommandPayload,
    rawItem: lsRawItem,
  };

  const sedCommandPayload = 'exit 0\ncontent';
  const sedRawItem = {
    id: 'call-sed-456',
    type: 'function_call_result',
    name: 'shell',
    arguments: JSON.stringify({ commands: 'sed -n "1,10p" file.txt' }),
  };
  const sedCommandItem = {
    type: 'tool_call_output_item',
    name: 'shell',
    output: sedCommandPayload,
    rawItem: sedRawItem,
  };

  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ commands: 'sed -n "1,10p" file.txt' }),
  };

  // Initial stream: emits 'ls' command, then hits approval for 'sed'
  const initialEvents = [{ type: 'run_item_stream_event', item: lsCommandItem }];
  const initialStream = new MockStream(initialEvents);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approveCalls: [],
    approve(arg: unknown) {
      (this as any).approveCalls.push(arg);
    },
    reject() {},
  };

  // Continuation stream: emits 'sed' command, history contains BOTH 'ls' and 'sed'
  const continuationEvents = [{ type: 'run_item_stream_event', item: sedCommandItem }];
  const continuationStream = new MockStream(continuationEvents);
  continuationStream.finalOutput = 'Done';
  // Simulate that the continuation stream's history contains both commands
  continuationStream.history = [lsCommandItem, sedCommandItem];

  const mockClient = partialClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
  });

  const emittedCommands: any[] = [];
  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  // Send initial message - should emit 'ls' and return approval_required
  const approvalResult = await service.sendMessage('run commands', {
    onCommandMessage(message) {
      emittedCommands.push(message);
    },
  });

  expect(approvalResult.type).toBe('approval_required');
  expect(emittedCommands.length).toBe(1);
  expect(emittedCommands[0].id).toBe('call-ls-123-0');

  // Handle approval - should emit 'sed' but NOT duplicate 'ls'
  const finalResult = await service.handleApprovalDecision('y', undefined, {
    onCommandMessage(message) {
      emittedCommands.push(message);
    },
  });

  expect(finalResult!.type).toBe('response');
  // Only 'sed' should be emitted during continuation
  expect(emittedCommands.length).toBe(2);
  expect(emittedCommands[1].id).toBe('call-sed-456-0');
  // Final result should have no additional commands since both were emitted live
  expect(asFinal(finalResult!).commandMessages).toEqual([]);
});

it('continuation replays the just-emitted tool in newItems without re-emitting it in the final result', async () => {
  // Regression: when the SDK continuation stream replays the tool that the
  // current turn has already emitted via command_message (in stream.newItems
  // and/or stream.history), the final response must not include that tool in
  // commandMessages. Otherwise applyServiceResult appends it to the messages
  // state and the user sees the finished tool output printed again after the
  // model's final answer.
  const commandPayload = 'exit 0\ncontent';
  const rawItem = {
    id: 'call-replay-1',
    type: 'function_call_result',
    name: 'shell',
    arguments: JSON.stringify({ commands: 'sed -n "1,10p" file.txt' }),
  };
  const commandItem = {
    type: 'tool_call_output_item',
    name: 'shell',
    output: commandPayload,
    rawItem,
  };
  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ commands: 'sed -n "1,10p" file.txt' }),
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approveCalls: [] as any[],
    approve(arg: any) {
      (this as any).approveCalls.push(arg);
    },
    reject() {},
  };

  const continuationEvents = [{ type: 'run_item_stream_event', item: commandItem }];
  const continuationStream = new MockStream(continuationEvents);
  continuationStream.finalOutput = 'Done';
  continuationStream.newItems = [commandItem];
  continuationStream.history = [commandItem];

  const mockClient = partialClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
  });

  const emittedCommands: any[] = [];
  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  const approvalResult = await service.sendMessage('run command', {
    onCommandMessage(message) {
      emittedCommands.push(message);
    },
  });
  expect(approvalResult.type).toBe('approval_required');

  const finalResult = await service.handleApprovalDecision('y', undefined, {
    onCommandMessage(message) {
      emittedCommands.push(message);
    },
  });
  expect(finalResult!.type).toBe('response');
  expect(emittedCommands.length).toBe(1);
  expect(emittedCommands[0].id).toBe('call-replay-1-0');
  expect(asFinal(finalResult!).commandMessages).toEqual([]);
});

it('resetWithNewId() clears conversation state', async () => {
  const streams = [new MockStream([]), new MockStream([])];
  streams[0].lastResponseId = 'resp-1';

  const startCalls: any[] = [];
  const mockClient = partialClient({
    async startStream(text: any, options: any) {
      startCalls.push({ text, options });
      return streams[startCalls.length - 1];
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  await service.sendMessage('first');

  service.resetWithNewId('new-id');

  await service.sendMessage('second');

  expect(startCalls[1].options).toMatchObject({ previousResponseId: null });
});

it('resetWithNewId() updates sessionId', () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    sessionId: 'old-id',
    deps: { logger: mockLogger, sessionContextService },
  });
  expect(service.sessionId).toBe('old-id');

  service.resetWithNewId('new-id');
  expect(service.sessionId).toBe('new-id');
});

it('resetWithNewId() clears provider conversations when supported', async () => {
  let clearCalls = 0;
  const mockClient = partialClient({
    clearConversations() {
      clearCalls++;
    },
    async startStream() {
      return new MockStream([]);
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  await service.sendMessage('first message');

  service.resetWithNewId('new-id');

  expect(clearCalls).toBe(1);
});

it('resetWithNewId() rediscover skills when skills service is available', async () => {
  let discoverCalls = 0;
  const mockSkillsService = {
    discoverSkills() {
      discoverCalls++;
    },
  } as any;

  const service = new ConversationService({
    agentClient: partialClient(),
    deps: { logger: mockLogger, sessionContextService, skillsService: mockSkillsService },
  });

  service.resetWithNewId('new-id');

  expect(discoverCalls).toBe(1);
});

it('setModel() delegates to agent client', () => {
  let setModelCalledWith: any = null;
  const mockClient = partialClient({
    setModel(model: string) {
      setModelCalledWith = model;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setModel('gpt-4');

  expect(setModelCalledWith).toBe('gpt-4');
});

it('setTemperature() delegates to agent client when supported', () => {
  let setTemperatureCalledWith: any = null;
  const mockClient = partialClient({
    setTemperature(value: number) {
      setTemperatureCalledWith = value;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setTemperature(0.7);

  expect(setTemperatureCalledWith).toBe(0.7);
});

it('abort() delegates to agent client and clears pending approval', async () => {
  let abortCalled = false;
  const mockClient = partialClient({
    abort() {
      abortCalled = true;
    },
    async startStream() {
      const stream = new MockStream([]);
      stream.interruptions = [
        {
          name: 'bash',
          agent: { name: 'CLI Agent' },
          arguments: JSON.stringify({ command: 'echo hi' }),
        },
      ];
      return stream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  // Trigger a pending approval
  await service.sendMessage('run command');

  service.abort();

  expect(abortCalled).toBe(true);

  const result = await service.handleApprovalDecision('y');
  expect(result).toBe(null);
});

it('abort() preserves the aborted tool turn in exported state and snapshot', async () => {
  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-abort',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approve() {},
    reject() {},
  };

  const service = new ConversationService({
    agentClient: partialClient({
      abort() {},
      async startStream() {
        return initialStream;
      },
    }),
    deps: { logger: mockLogger, sessionContextService },
  });

  const first = await service.sendMessage('run command');
  expect(first.type).toBe('approval_required');

  service.abort();

  const exported = service.exportState();
  const snapshot = service.getCurrentSnapshot();

  for (const state of [exported, snapshot]) {
    expect(state.history.map((item: any) => item.type)).toEqual(['message', 'function_call', 'tool_call_output_item']);
    expect((state.history[1] as any).callId).toBe('call-abort');
    expect((state.history[2] as any).callId).toBe('call-abort');
    expect((state.history[2] as any).output).toBe('Tool execution was not approved.');
  }
});

it('switchProvider() after abort reuses the preserved tool turn in the next full-history request', async () => {
  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-abort',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approve() {},
    reject() {},
  };

  const followupStream = new MockStream([]);
  followupStream.finalOutput = 'Next';

  const startCalls: any[] = [];
  const mockClient = partialClient({
    getProvider() {
      return 'openrouter';
    },
    abort() {},
    setProvider() {},
    clearConversations() {},
    async startStream(input: any) {
      startCalls.push(input);
      return startCalls.length === 1 ? initialStream : followupStream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  const first = await service.sendMessage('run command');
  expect(first.type).toBe('approval_required');

  service.abort();
  service.switchProvider('openrouter');

  const second = await service.sendMessage('next');
  expect(second.type).toBe('response');

  expect(startCalls.length).toBe(2);
  expect(startCalls[1].map((item: any) => item.type)).toEqual([
    'message',
    'function_call',
    'tool_call_output_item',
    'message',
  ]);
  expect(startCalls[1][1].callId).toBe('call-abort');
  expect(startCalls[1][2].callId).toBe('call-abort');
  expect(startCalls[1][2].output).toBe('Tool execution was not approved.');
  expect(startCalls[1][3].content).toBe('next');
});

it('handleApprovalDecision() rejects interruption when answer is n', async () => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approveCalls: [],
    rejectCalls: [],
    approve(arg: unknown) {
      (this as any).approveCalls.push(arg);
    },
    reject(arg: unknown) {
      (this as any).rejectCalls.push(arg);
    },
  };

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Rejected run' }]);
  continuationStream.finalOutput = 'Rejected run';

  const mockClient = partialClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream(_state: any, options: any) {
      expect(options).toEqual({
        previousResponseId: 'resp_test',
        sessionId: 'default',
        toolResultCallIds: [],
      });
      return continuationStream;
    },
    addToolInterceptor(_fn: any) {
      return () => {};
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  await service.sendMessage('run command');

  const finalResult = await service.handleApprovalDecision('n');

  expect(finalResult!.type).toBe('response');
  expect(initialStream.state.approveCalls).toEqual([]);
  expect(initialStream.state.rejectCalls).toEqual([interruption]);
});

it('handleApprovalDecision() returns null when no pending approval', async () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.handleApprovalDecision('y');
  expect(result).toBe(null);
});

it('emits live reasoning chunks', async () => {
  expect.assertions(3);

  // Reasoning is now streamed via model events carrying reasoning_summary_text deltas
  const events = [
    {
      type: 'response.output_text.delta',
      data: {
        type: 'model',
        event: {
          type: 'response.reasoning_summary_text.delta',
          delta: 'Thinking...',
        },
      },
    },
    {
      type: 'response.output_text.delta',
      data: {
        type: 'model',
        event: {
          type: 'response.reasoning_summary_text.delta',
          delta: ' Still thinking.',
        },
      },
    },
  ];

  const mockClient = partialClient({
    async startStream() {
      return new MockStream(events);
    },
  });

  const chunks: any[] = [];
  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('hi', {
    onReasoningChunk(full, chunk) {
      chunks.push({ full, chunk });
    },
  });

  expect(chunks).toEqual([
    { full: 'Thinking...', chunk: 'Thinking...' },
    { full: 'Thinking... Still thinking.', chunk: ' Still thinking.' },
  ]);
  expect(result.type).toBe('response');
  expect(asFinal(result).reasoningText).toBe('Thinking... Still thinking.');
});

it('retries on tool hallucination error (ModelBehaviorError)', async () => {
  // Import ModelBehaviorError dynamically
  const { ModelBehaviorError } = await import('@openai/agents');

  let callCount = 0;
  const mockClient = partialClient({
    async startStream() {
      callCount++;
      if (callCount === 1) {
        // First call: model hallucinates a non-existent tool
        throw new ModelBehaviorError('Tool open_file not found in agent Terminal Assistant.');
      }
      // Second call: succeeds
      const stream = new MockStream([
        {
          type: 'response.output_text.delta',
          delta: 'Retried successfully',
        },
      ]);
      stream.finalOutput = 'Retried successfully';
      return stream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const result = await service.sendMessage('explain this file');

  // Should have retried and succeeded on second attempt
  expect(callCount).toBe(2);
  expect(result.type).toBe('response');
  expect(asFinal(result).finalText).toBe('Retried successfully');
});

it('stops retrying after max hallucination retries', async () => {
  const { ModelBehaviorError } = await import('@openai/agents');

  let callCount = 0;
  const mockClient = partialClient({
    async startStream() {
      callCount++;
      // Always throw hallucination error
      throw new ModelBehaviorError('Tool fake_tool not found in agent Test Agent.');
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  try {
    await service.sendMessage('test message');
    throw new Error('Should have thrown error after max retries');
  } catch (error: unknown) {
    // collectTerminalResult re-throws the error event message as a plain Error,
    // so the original ModelBehaviorError is not preserved.
    expect((error as Error).message).toBe('Tool fake_tool not found in agent Test Agent.');
    // Should have tried: initial + 2 retries = 3 total attempts
    expect(callCount).toBe(3);
  }
});

it('does not retry on non-hallucination ModelBehaviorError', async () => {
  const { ModelBehaviorError } = await import('@openai/agents');

  let callCount = 0;
  const mockClient = partialClient({
    async startStream() {
      callCount++;
      // Throw a different kind of ModelBehaviorError
      throw new ModelBehaviorError('Model violated safety guidelines');
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  try {
    await service.sendMessage('test message');
    throw new Error('Should have thrown error');
  } catch (error: unknown) {
    // collectTerminalResult re-throws the error event message as a plain Error,
    // so the original ModelBehaviorError is not preserved.
    expect((error as Error).message).toBe('Model violated safety guidelines');
    // Should NOT retry - only 1 call
    expect(callCount).toBe(1);
  }
});

it('failed user turn is dropped from history after non-retryable provider error', async () => {
  const startCalls: any[] = [];
  const mockClient = partialClient({
    getProvider() {
      return 'openrouter';
    },
    async startStream(input: any) {
      startCalls.push(input);
      if (startCalls.length === 1) {
        throw new Error('400 Error from provider: bad request');
      }

      const stream = new MockStream([
        {
          type: 'response.output_text.delta',
          delta: 'ok',
        },
      ]);
      stream.finalOutput = 'ok';
      return stream;
    },
  });

  const service = new ConversationService({
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  await expect(service.sendMessage('first failed message')).rejects.toThrow('400 Error from provider: bad request');

  const result = await service.sendMessage('second message');

  expect(result.type).toBe('response');
  expect(startCalls.length).toBe(2);
  // The session removes the failed user turn from the store before yielding the
  // error event (so the drop happens regardless of generator-cleanup semantics),
  // and surfaces the dropped text on the error event for UI restoration. The
  // next request must not include the stranded first turn.
  expect(startCalls[1]).toEqual([
    {
      role: 'user',
      type: 'message',
      content: 'second message',
    },
  ]);
});
