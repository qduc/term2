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
  ROLE_RESEARCHER,
} from './test-helpers/subagent-manager-fixtures.js';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { ModelBehaviorError } from '@openai/agents';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

it('run() retries on recoverable model error (hallucinated tool) and succeeds on second attempt', async () => {
  let runCount = 0;
  const events: any[] = [];
  const logWarnCalls: any[] = [];

  const providerId = registerTestProvider({
    label: 'Mock Retry Recoverable Provider',
    createRunner: () =>
      ({
        run: async () => {
          runCount++;
          if (runCount === 1) {
            return wrapErrorAsAgentStream(new ModelBehaviorError('Tool bash not found in agent Explorer.'));
          }
          const result = {
            status: 'completed',
            finalOutput: 'Success on retry',
            history: [],
            messages: [],
          };
          return wrapResultAsAgentStream(result);
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
    createRunner: () =>
      ({
        run: async () => {
          runCount++;
          return wrapErrorAsAgentStream(new ModelBehaviorError('Tool bash not found in agent Explorer.'));
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
    createRunner: () =>
      ({
        run: async () => {
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
    createRunner: () =>
      ({
        run: async () => {
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

it('run() does not restart read-only subagent from the beginning after a recoverable model error', async () => {
  let runCount = 0;
  const events: any[] = [];

  const providerId = registerTestProvider({
    label: 'Mock Explorer Read Then Crash Provider',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          runCount++;
          if (runCount === 1) {
            // Call a read tool then throw a recoverable error
            const grep = agent.tools.find((tool: any) => tool.name === 'grep');
            if (grep) {
              await grep.invoke({}, JSON.stringify({ pattern: 'foo', path: '.' }), {}).catch(() => {});
            }
            throw new ModelBehaviorError('Tool bash not found in agent Explorer.');
          }
          const result = { status: 'completed', finalOutput: 'found it', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
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

  const result = await manager.run({ role: 'explorer', task: 'search for something' });

  expect(result.status).toBe('failed');
  expect(result.error?.includes('bash')).toBe(true);
  expect(runCount, 'subagent must not restart from the beginning when no resumable stream exists').toBe(1);
  expect(events.filter((event) => event.type === 'retry').length).toBe(0);
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
      createRunner: () =>
        ({
          run: async (agent: any) => {
            // Simulate using a tool
            const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
            if (createFile) {
              await createFile.invoke({}, JSON.stringify({ path: 'test.ts', content: 'x' }), {});
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
