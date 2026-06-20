import { it, expect } from 'vitest';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  mockLogger,
  sessionContextService,
  createMockAgentClient,
} from './test-helpers/conversation-session-fixtures.js';
import type { ClientCall } from './test-helpers/conversation-session-fixtures.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
it('run() sends text for OpenAI provider (server-side state)', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';

  let receivedInput: unknown;
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      receivedInput = input;
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
  for await (const ev of turnCoordinator.start('Hello')) {
    emitted.push(ev);
  }

  // OpenAI should receive just the text string (no getProvider means default 'openai')
  expect(typeof receivedInput).toBe('string');
  expect(receivedInput).toBe('Hello');
  expect((emitted[emitted.length - 1] as ConversationEvent).type).toBe('final');
});

it('run() sends full history for non-OpenAI providers (client-side state)', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.history = [
    { role: 'user', type: 'message', content: 'Hello' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Response' }],
    },
  ];

  let receivedInput: unknown;
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      receivedInput = input;
      return stream;
    },
    getProvider() {
      return 'openrouter'; // Non-OpenAI provider
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('Hello')) {
    emitted.push(ev);
  }

  // Non-OpenAI providers should receive full history array
  expect(Array.isArray(receivedInput)).toBe(true);
  expect((receivedInput as unknown[]).length).toBe(1); // Initial user message
  expect((receivedInput as Record<string, unknown>[])[0].role).toBe('user');
  expect((receivedInput as Record<string, unknown>[])[0].content).toBe('Hello');
  expect((emitted[emitted.length - 1] as ConversationEvent).type).toBe('final');
});

it('run() preserves assistant text prefix when SDK full-history reconstruction strips it', async () => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'I will inspect the files.' }]);
  firstStream.finalOutput = 'I will inspect the files.';
  firstStream.output = [];
  firstStream.newItems = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I will inspect the files.' }],
    },
  ];

  firstStream.history = [
    { role: 'user', type: 'message', content: 'Investigate cache issue' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"source/app.tsx"}' },
        },
      ],
    },
  ];

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Continuing.' }]);
  secondStream.finalOutput = 'Continuing.';
  secondStream.output = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Continuing.' }],
    },
  ];

  const calls: unknown[] = [];
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      calls.push(input);
      return calls.length === 1 ? firstStream : secondStream;
    },
    getProvider() {
      return 'openrouter';
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  for await (const _ of turnCoordinator.start('Investigate cache issue')) {
    // consume events
  }
  for await (const _ of turnCoordinator.start('Continue after max turns')) {
    // consume events
  }
  const secondInput = calls[1] as unknown[];
  expect(Array.isArray(secondInput)).toBe(true);
  expect(secondInput.slice(0, 3)).toEqual([
    { role: 'user', type: 'message', content: 'Investigate cache issue' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I will inspect the files.' }],
    },
    { role: 'user', type: 'message', content: 'Continue after max turns' },
  ]);
});

it('run() sends full history for openai-compatible providers', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.history = [
    { role: 'user', type: 'message', content: 'First message' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'First response' }],
    },
    { role: 'user', type: 'message', content: 'Second message' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Response' }],
    },
  ];

  let firstInput: unknown, secondInput: unknown;
  let callCount = 0;
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      callCount++;
      if (callCount === 1) {
        firstInput = input;
      } else {
        secondInput = input;
      }
      return stream;
    },
    getProvider() {
      return 'deepseek'; // Custom openai-compatible provider
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  // First message
  for await (const _ of turnCoordinator.start('First message')) {
    // consume events
  }
  // OpenAI-compatible provider should receive full history array
  expect(Array.isArray(firstInput)).toBe(true);
  expect((firstInput as unknown[]).length).toBe(1);
  expect((firstInput as Record<string, unknown>[])[0].content).toBe('First message');

  // Second message should contain both previous and new message
  for await (const _ of turnCoordinator.start('Second message')) {
    // consume events
  }
  expect(Array.isArray(secondInput)).toBe(true);
  expect((secondInput as unknown[]).length >= 2).toBe(true);
});

it('run() chains follow-up turns for Codex provider over websocket', async () => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'First response' }]);
  firstStream.finalOutput = 'First response';
  firstStream.lastResponseId = 'resp-codex-1';
  firstStream.history = [
    { role: 'user', type: 'message', content: 'First message' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'First response' }],
    },
  ];

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Second response' }]);
  secondStream.finalOutput = 'Second response';
  secondStream.lastResponseId = 'resp-codex-2';
  secondStream.history = [
    ...firstStream.history,
    { role: 'user', type: 'message', content: 'Second message' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Second response' }],
    },
  ];

  const calls: ClientCall[] = [];
  const mockClient = createMockAgentClient({
    async startStream(input: unknown, opts?: unknown) {
      calls.push({ input, opts });
      return calls.length === 1 ? firstStream : secondStream;
    },
    getProvider() {
      return 'codex';
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  for await (const _ of turnCoordinator.start('First message')) {
    // consume events
  }
  for await (const _ of turnCoordinator.start('Second message')) {
    // consume events
  }
  const firstCodexCall = calls[0] as { input: unknown; opts: Record<string, unknown> };
  expect(typeof firstCodexCall.input, 'Codex should send only the first user message on turn 1').toBe('string');
  expect(firstCodexCall.opts.previousResponseId).toBeFalsy();
  const secondCodexCall = calls[1] as { input: unknown; opts: Record<string, unknown> };
  expect(typeof secondCodexCall.input, 'Codex should send only the next user message on turn 2').toBe('string');
  expect(secondCodexCall.input).toBe('Second message');
  expect(secondCodexCall.opts.previousResponseId, 'Codex should chain follow-up turns from turn 1').toBe(
    'resp-codex-1',
  );
});
