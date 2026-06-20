import { it, expect } from 'vitest';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  mockLogger,
  sessionContextService,
  createMockAgentClient,
} from './test-helpers/conversation-session-fixtures.js';
import type { ConversationEvent, UsageUpdateEvent } from '../conversation/conversation-events.js';
it('sendMessage() returns usage from final event', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  });

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('Hello');

  expect((result as unknown as Record<string, unknown>).type).toBe('response');
  expect((result as unknown as Record<string, unknown>).usage).toEqual({
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  });
});

it('handleApprovalDecision() returns usage from final event', async () => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-xyz',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approve() {},
    reject() {},
  };

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved run' }]);
  continuationStream.finalOutput = 'Approved run';
  continuationStream.completed = Promise.resolve({
    usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
  });

  const mockClient = createMockAgentClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('run command');
  expect((approvalResult as unknown as Record<string, unknown>).type).toBe('approval_required');

  const finalResult = await terminalAdapter.handleApprovalDecision('y');
  expect((finalResult as unknown as Record<string, unknown>).type).toBe('response');
  expect((finalResult as unknown as Record<string, unknown>).usage).toEqual({
    prompt_tokens: 21,
    completion_tokens: 9,
    total_tokens: 30,
  });
});

it('sendMessage() logs usage handoff at DEBUG level', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
  });

  const debugLogs: { message: string; meta?: unknown }[] = [];
  const logger = {
    ...mockLogger,
    debug: (message: string, meta?: unknown) => {
      debugLogs.push({ message, meta });
    },
  };

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  await terminalAdapter.sendMessage('Hello');

  const hasUsageReturnLog = debugLogs.some(
    (log) =>
      log.message === 'sendMessage returning response' &&
      (log.meta as Record<string, unknown> | undefined)?.hasUsage === true,
  );
  expect(hasUsageReturnLog).toBe(true);
});

it('logs diagnostics when usage is missing in stream completion', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({ foo: 'bar' });

  const debugLogs: { message: string; meta?: unknown }[] = [];
  const logger = {
    ...mockLogger,
    debug: (message: string, meta?: unknown) => {
      debugLogs.push({ message, meta });
    },
  };

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  await terminalAdapter.sendMessage('Hello');

  const missingUsageLog = debugLogs.find((log) => log.message === 'No usage found in stream completion');
  expect(missingUsageLog).toBeTruthy();
  expect(
    Array.isArray((missingUsageLog as { message: string; meta?: Record<string, unknown> }).meta?.completedResultKeys),
  ).toBe(true);
});

it('sendMessage() extracts usage from stream.rawResponses when completed is void', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve(undefined);
  (stream as unknown as Record<string, unknown>).rawResponses = [
    { usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 } },
  ];

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('Hello');
  expect((result as unknown as Record<string, unknown>).type).toBe('response');
  expect((result as unknown as Record<string, unknown>).usage).toEqual({
    prompt_tokens: 13,
    completion_tokens: 8,
    total_tokens: 21,
  });
});

it('sendMessage() preserves cache usage from streaming events when final usage omits it', async () => {
  const events = [
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        },
      },
    },
  ];

  const stream = new MockStream(events);
  stream.completed = Promise.resolve({
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  });

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('Hello');
  expect((result as unknown as Record<string, unknown>).type).toBe('response');
  expect((result as unknown as Record<string, unknown>).usage).toEqual({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cache_read_tokens: 60,
  });
});

it('run() emits usage_update when usage is nested in event.data (raw_model_stream_event)', async () => {
  // Simulates a raw_model_stream_event with type 'response.completed' where
  // usage lives at event.data.response.usage
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      },
    },
  ];

  const stream = new MockStream(events);
  stream.finalOutput = 'Hello';

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('hi')) {
    emitted.push(ev);
  }

  const usageEvents = emitted.filter((e: ConversationEvent) => e.type === 'usage_update');
  expect(usageEvents.length >= 1).toBe(true);
  expect((usageEvents[0] as UsageUpdateEvent).usage.prompt_tokens).toBe(50);
  expect((usageEvents[0] as UsageUpdateEvent).usage.completion_tokens).toBe(25);
  expect((usageEvents[0] as UsageUpdateEvent).usage.total_tokens).toBe(75);
});

it('run() emits usage_update when raw model stream usage is nested in event.data.event', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          id: '8d03b4e8-46ab-45f7-aed4-670157c3dd6d',
          object: 'chat.completion.chunk',
          created: 1778912418,
          model: 'deepseek-v4-flash',
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        },
        providerData: {
          rawModelEventSource: 'openai-chat-completions',
        },
      },
    },
  ];

  const stream = new MockStream(events);
  stream.finalOutput = 'Hello';

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('hi')) {
    emitted.push(ev);
  }

  const usageEvents = emitted.filter((e: ConversationEvent) => e.type === 'usage_update');
  expect(usageEvents.length >= 1).toBe(true);
  expect((usageEvents[0] as UsageUpdateEvent).usage.prompt_tokens).toBe(8);
  expect((usageEvents[0] as UsageUpdateEvent).usage.completion_tokens).toBe(3);
  expect((usageEvents[0] as UsageUpdateEvent).usage.total_tokens).toBe(11);
});

it('run() emits usage_update when usage is at top level of event', async () => {
  // Simulates events that have usage directly on the event (e.g. response.done)
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    {
      type: 'response.done',
      response: {
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
  ];

  const stream = new MockStream(events);
  stream.finalOutput = 'Hello';

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('hi')) {
    emitted.push(ev);
  }

  const usageEvents = emitted.filter((e: ConversationEvent) => e.type === 'usage_update');
  expect(usageEvents.length >= 1).toBe(true);
  expect((usageEvents[0] as UsageUpdateEvent).usage.prompt_tokens).toBe(100);
  expect((usageEvents[0] as UsageUpdateEvent).usage.completion_tokens).toBe(50);
  expect((usageEvents[0] as UsageUpdateEvent).usage.total_tokens).toBe(150);
});
