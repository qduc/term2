import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  createMockExecutionContext,
  createTempDir,
  removeTempDir,
  registerTestProvider,
  wrapResultAsAgentStream,
  wrapErrorAsAgentStream,
  getAgentTool,
  ROLE_MENTOR,
  ROLE_EXPLORER,
  ROLE_WORKER,
} from './test-helpers/subagent-manager-fixtures.js';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { ModelBehaviorError } from '../../contracts/model-errors.js';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

it('run() retries on recoverable model error (hallucinated tool) and succeeds on second attempt', async () => {
  let runCount = 0;
  const events: any[] = [];
  const logWarnCalls: any[] = [];

  const providerId = registerTestProvider({
    label: 'Mock Retry Recoverable Provider',
    createStreamedModel: () =>
      ({
        stream: async function* () {
          runCount++;
          if (runCount === 1) {
            yield* wrapErrorAsAgentStream(new ModelBehaviorError('Tool bash not found in agent Explorer.'));
          }
          const result = {
            status: 'completed',
            finalOutput: 'Success on retry',
            history: [],
            messages: [],
          };
          yield* wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new TestSubagentManager({
    logger: {
      ...createMockLogger(),
      warn: (msg: string, meta?: Record<string, unknown>) => {
        logWarnCalls.push({ msg, meta });
      },
    },
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  expect(result.status).toBe('completed');
  expect(runCount).toBe(2);
  const retryEvent = events.find((e) => e.type === 'retry');
  expect(retryEvent).toBeTruthy();
  expect(retryEvent.toolName).toBe('bash');
  expect(retryEvent.retryType).toBe('hallucination');
  expect(retryEvent.attempt).toBe(1);
  expect(retryEvent.maxRetries).toBe(MAX_SUBAGENT_MODEL_RETRIES);

  const retryLog = logWarnCalls.find((c) => c.meta?.eventType === 'retry.model_error');
  expect(retryLog).toBeTruthy();
});

it('run() exhausts retries on repeated recoverable model errors and returns failed result', async () => {
  let runCount = 0;
  const events: any[] = [];

  const providerId = registerTestProvider({
    label: 'Mock Retry Exhaust Provider',
    createStreamedModel: () =>
      ({
        stream: async function* () {
          runCount++;
          yield* wrapErrorAsAgentStream(new ModelBehaviorError('Tool bash not found in agent Explorer.'));
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  expect(result.status).toBe('failed');
  expect(result.error).toBeTruthy();
  expect(result.error!.includes('bash')).toBe(true);
  // Should have tried: initial + MAX_SUBAGENT_MODEL_RETRIES retries.
  expect(runCount).toBe(1 + MAX_SUBAGENT_MODEL_RETRIES);
  const retryEvents = events.filter((e) => e.type === 'retry');
  expect(retryEvents.length, 'should emit one retry event per retry attempt').toBe(MAX_SUBAGENT_MODEL_RETRIES);
});

it('run() does not retry on non-recoverable ModelBehaviorError', async () => {
  let runCount = 0;
  const events: any[] = [];

  const providerId = registerTestProvider({
    label: 'Mock No Retry Non-Recoverable Provider',
    createStreamedModel: () =>
      ({
        stream: async function* () {
          runCount++;
          throw new ModelBehaviorError('something else unrelated to tools');
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  expect(result.status).toBe('failed');
  expect(runCount, 'no retry should be attempted').toBe(1);
  const retryEvents = events.filter((e) => e.type === 'retry');
  expect(retryEvents.length).toBe(0);
});

it('run() aborted subagent returns cancelled status without model-error retry', async () => {
  const events: any[] = [];

  const providerId = registerTestProvider({
    label: 'Mock Abort No Retry Provider',
    createStreamedModel: () =>
      ({
        stream: async function* () {
          const err = new Error('The operation was aborted');
          (err as any).name = 'AbortError';
          throw err;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  expect(result.status).toBe('cancelled');
  const retryEvents = events.filter((e) => e.type === 'retry');
  expect(retryEvents.length, 'abort errors should not trigger model-error retries').toBe(0);
});

it('run() retries a direct streamed read-only subagent after a recoverable model error', async () => {
  let runCount = 0;
  const events: any[] = [];

  const providerId = registerTestProvider({
    label: 'Mock Explorer Read Then Crash Provider',
    createStreamedModel: () => ({
      async *stream() {
        runCount++;
        throw new ModelBehaviorError('Tool bash not found in agent Explorer.');
      },
    }),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'search for something' });

  expect(result.status).toBe('failed');
  expect(result.error?.includes('bash')).toBe(true);
  expect(runCount).toBe(1 + MAX_SUBAGENT_MODEL_RETRIES);
  expect(events.filter((event) => event.type === 'retry').length).toBe(MAX_SUBAGENT_MODEL_RETRIES);
});

describe('run() aborted subagent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir('term2-test-abort-');
  });

  afterEach(() => {
    removeTempDir(tmpDir);
  });

  it('retains toolsUsed and filesChanged', async () => {
    const providerId = registerTestProvider({
      label: 'Mock Abort Retain Provider',
      createStreamedModel: () =>
        ({
          stream: async function* (request: any) {
            // Simulate using a tool
            const createFile = request.applicationTools?.find((tool: any) => tool.name === 'create_file');
            if (createFile) {
              await createFile.execute(JSON.stringify({ path: 'test.ts', content: 'x' }), {}, {});
            }
            const err = new Error('The operation was aborted');
            (err as any).name = 'AbortError';
            throw err;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': providerId,
      }),
      sessionContextService: createSessionContextService() as any,
      executionContext: createMockExecutionContext(tmpDir),
    });

    const result = await manager.run({ role: 'worker', task: 'find all files' });

    expect(result.status).toBe('cancelled');
    expect(result.toolsUsed.length).toBe(1);
    expect(result.toolsUsed[0].toolName).toBe('create_file');
    expect(result.filesChanged).toEqual(['test.ts']);
  });
});

it('run() retries a mid-stream transport drop instead of failing the subagent', async () => {
  // Regression: subagents disable fresh-start retries so they cannot replay a
  // task from scratch. That must not also block recovery from a connection the
  // server closed mid-response, which is a transient transport failure.
  let runCount = 0;
  const events: any[] = [];

  const socketCloseError = new TypeError();
  socketCloseError.stack = 'TypeError\n    at #onSocketClose (node:internal/deps/undici/undici:15499:20)';

  const providerId = registerTestProvider({
    label: 'Mock Mid-Stream Transport Drop Provider',
    createStreamedModel: () =>
      ({
        stream: async function* () {
          runCount++;
          if (runCount === 1) {
            yield* wrapErrorAsAgentStream(socketCloseError);
          }
          yield* wrapResultAsAgentStream({
            status: 'completed',
            finalOutput: 'Recovered after transport drop',
            history: [],
            messages: [],
          });
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  expect(result.status).toBe('completed');
  expect(result.finalText).toBe('Recovered after transport drop');
  expect(runCount).toBe(2);
  const retryEvent = events.find((e) => e.type === 'retry');
  expect(retryEvent?.retryType).toBe('upstream');
});

it('run() retries when a chat stream ends without a finish reason', async () => {
  // Same recovery path as a transport drop: subagents must not fail a worker
  // permanently when the provider closes SSE before a finish_reason frame.
  let runCount = 0;
  const events: any[] = [];

  const incompleteStreamError = new Error('OpenAI-compatible streamed response ended without a finish reason');

  const providerId = registerTestProvider({
    label: 'Mock Incomplete Stream Finish Provider',
    createStreamedModel: () =>
      ({
        stream: async function* () {
          runCount++;
          if (runCount === 1) {
            yield* wrapErrorAsAgentStream(incompleteStreamError);
          }
          yield* wrapResultAsAgentStream({
            status: 'completed',
            finalOutput: 'Recovered after incomplete stream',
            history: [],
            messages: [],
          });
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': providerId,
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'worker', task: 'implement the change' });

  expect(result.status).toBe('completed');
  expect(result.finalText).toBe('Recovered after incomplete stream');
  expect(runCount).toBe(2);
  const retryEvent = events.find((e) => e.type === 'retry');
  expect(retryEvent?.retryType).toBe('upstream');
});
