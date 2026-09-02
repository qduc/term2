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
} from './test-helpers/subagent-manager-fixtures.js';
import { ModelBehaviorError } from '../../contracts/model-errors.js';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

interface RetryCase {
  title: string;
  task: string;
  /** Error delivered when an attempt should fail; null means the attempt succeeds. */
  error: () => Error | null;
  /** How the model delivers the error: as a wrapped agent stream or a direct throw. */
  delivery: 'wrapped' | 'direct';
  /** Attempt number after which the stream succeeds; Infinity means every attempt fails. */
  succeedsAfter: number;
  expected: {
    status: 'completed' | 'failed' | 'cancelled';
    runCount: number;
    retryEvents: number;
    finalText?: string;
    errorIncludes?: string;
  };
  /** Detail asserted on the first retry event, when one is expected. */
  retryEvent?: { toolName: string; retryType: string; attempt: number; maxRetries: number };
  /** Assert the retry warn log fired. */
  expectRetryWarnLog?: boolean;
}

const hallucinatedToolError = () => new ModelBehaviorError('Tool bash not found in agent Explorer.');
const unrelatedError = () => new ModelBehaviorError('something else unrelated to tools');
const abortError = () => {
  const err = new Error('The operation was aborted');
  (err as any).name = 'AbortError';
  return err;
};

// One table per error class: the manager/run/event plumbing is shared while
// each row keeps its own delivery style, recovery point, and expectation so no
// production branch (wrapped event vs direct throw, recoverable vs exhaustion,
// non-recoverable, abort) is collapsed into another.
const retryCases: RetryCase[] = [
  {
    title: 'retries a wrapped hallucinated-tool error and succeeds on the next attempt',
    task: 'find all files',
    error: hallucinatedToolError,
    delivery: 'wrapped',
    succeedsAfter: 2,
    expected: { status: 'completed', runCount: 2, retryEvents: 1, finalText: 'Success on retry' },
    retryEvent: { toolName: 'bash', retryType: 'hallucination', attempt: 1, maxRetries: MAX_SUBAGENT_MODEL_RETRIES },
    expectRetryWarnLog: true,
  },
  {
    title: 'exhausts retries on repeated wrapped hallucinated-tool errors',
    task: 'find all files',
    error: hallucinatedToolError,
    delivery: 'wrapped',
    succeedsAfter: Infinity,
    expected: {
      status: 'failed',
      runCount: 1 + MAX_SUBAGENT_MODEL_RETRIES,
      retryEvents: MAX_SUBAGENT_MODEL_RETRIES,
      errorIncludes: 'bash',
    },
  },
  {
    title: 'does not retry a wrapped non-recoverable model error',
    task: 'find all files',
    error: unrelatedError,
    delivery: 'wrapped',
    succeedsAfter: Infinity,
    expected: { status: 'failed', runCount: 1, retryEvents: 0 },
  },
  {
    title: 'reports cancelled without retry on an AbortError',
    task: 'find all files',
    error: abortError,
    delivery: 'direct',
    succeedsAfter: Infinity,
    expected: { status: 'cancelled', runCount: 1, retryEvents: 0 },
  },
  {
    title: 'exhausts retries on a directly-thrown hallucinated-tool error',
    task: 'search for something',
    error: hallucinatedToolError,
    delivery: 'direct',
    succeedsAfter: Infinity,
    expected: {
      status: 'failed',
      runCount: 1 + MAX_SUBAGENT_MODEL_RETRIES,
      retryEvents: MAX_SUBAGENT_MODEL_RETRIES,
      errorIncludes: 'bash',
    },
  },
];

it.each(retryCases)('$title', async (c) => {
  let runCount = 0;
  const events: any[] = [];
  const logWarnCalls: any[] = [];

  const providerId = registerTestProvider({
    label: `Mock Retry Provider ${c.title}`,
    createStreamedModel: () =>
      ({
        stream: async function* () {
          runCount++;
          if (runCount < c.succeedsAfter) {
            const error = c.error();
            if (error === null) throw new Error('scenario error: no error factory for failing attempt');
            if (c.delivery === 'wrapped') {
              yield* wrapErrorAsAgentStream(error);
            } else {
              throw error;
            }
          }
          yield* wrapResultAsAgentStream({
            status: 'completed',
            finalOutput: 'Success on retry',
            history: [],
            messages: [],
          });
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

  const result = await manager.run({ role: 'explorer', task: c.task });

  expect(result.status).toBe(c.expected.status);
  if (c.expected.finalText !== undefined) {
    expect(result.finalText).toBe(c.expected.finalText);
  }
  if (c.expected.errorIncludes !== undefined) {
    expect(result.error).toBeTruthy();
    expect(result.error!.includes(c.expected.errorIncludes)).toBe(true);
  }
  expect(runCount).toBe(c.expected.runCount);
  const retryEvents = events.filter((e) => e.type === 'retry');
  expect(retryEvents.length).toBe(c.expected.retryEvents);

  if (c.retryEvent) {
    const retryEvent = retryEvents[0];
    expect(retryEvent).toBeTruthy();
    expect(retryEvent.toolName).toBe(c.retryEvent.toolName);
    expect(retryEvent.retryType).toBe(c.retryEvent.retryType);
    expect(retryEvent.attempt).toBe(c.retryEvent.attempt);
    expect(retryEvent.maxRetries).toBe(c.retryEvent.maxRetries);
  }
  if (c.expectRetryWarnLog) {
    const retryLog = logWarnCalls.find((log) => log.meta?.eventType === 'retry.model_error');
    expect(retryLog).toBeTruthy();
  }
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

it('run() recovers an incomplete chat stream inside the application loop without an outer retry', async () => {
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
  expect(retryEvent).toBeUndefined();
});
