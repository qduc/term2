import { it, expect } from 'vitest';
import { createSessionRuntimeInternals } from './session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import { TurnAttempt } from './turn-attempt.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { AbortedApprovalContext } from '../approval/approval-state.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

const createSessionContextService = () => {
  let capturedContext: any = null;
  return {
    runWithContext: (context: any, fn: any) => {
      capturedContext = context;
      return fn();
    },
    getContext: () => capturedContext,
  };
};

function setupWorkflow(mockClient: any, retryOptions?: any) {
  const composition = createSessionRuntimeInternals({
    sessionId: 'test-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
    retryOptions,
  });

  return { workflow: composition.turnWorkflow, composition };
}

const defaultRetryCounts: RetryCounts = {
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

it('executes initial turn successfully', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'hello response' }]);
  stream.finalOutput = 'hello response';

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      return stream;
    },
  };

  const { workflow, composition } = setupWorkflow(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  const events: any[] = [];
  const runPromise = (async () => {
    const iterator = workflow.executeInitial(attempt);
    let res = await iterator.next();
    while (!res.done) {
      events.push(res.value);
      res = await iterator.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    expect(outcome.terminal.finalText).toBe('hello response');
  } else {
    expect(true).toBe(false);
  }
  expect(attempt.closed).toBe(true);
});

it('executes continuation turn successfully', async () => {
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async continueRunStream() {
      const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'continuation response' }]);
      stream.finalOutput = 'continuation response';
      return stream;
    },
  };

  const { workflow, composition } = setupWorkflow(mockClient);

  const token = composition.generationGuard.capture();
  composition.approvalFlow.prepareContinuation = () =>
    ({
      pendingApprovalContext: {
        state: {},
        interruption: {
          type: 'tool_approval_item',
          callId: 'call-1',
          name: 'shell',
          arguments: '{}',
        },
        toolCallArgumentsById: new Map([['call-1', '{}']]),
        emittedCommandIds: new Set<string>(),
        token,
        inputMode: 'delta',
        cumulativeUsage: {},
        cumulativeCommandMessages: [],
        cumulativeTurnItems: [],
      },
      toolStartedEvent: undefined,
      removeInterceptor: () => {},
    } as any);

  const events: any[] = [];
  const runPromise = (async () => {
    const iterator = workflow.executeContinuation({
      kind: 'approval_decision',
      answer: 'y',
      generation: token,
    });
    let res = await iterator.next();
    while (!res.done) {
      events.push(res.value);
      res = await iterator.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    expect(outcome.terminal.finalText).toBe('continuation response');
  } else {
    expect(true).toBe(false);
  }
});

const collect = async (iterable: AsyncGenerator<any, any, void>) => {
  const events: any[] = [];
  let next = await iterable.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterable.next();
  }
  return { events, outcome: next.value };
};

it('executeInitial resolves aborted approvals through continuation', async () => {
  const { workflow } = setupWorkflow(null);
  const abortedContext = { token: 7, interruption: { id: 'interrupt-1' } };

  (workflow as any).executeInitialAttempt = async function* () {
    yield { type: 'text_delta', delta: 'initial text' };
    return {
      kind: 'abort_resolution_required',
      abortedContext,
      userText: 'next request',
      generation: 7,
    };
  };

  (workflow as any).executeContinuationAttempt = async function* (init: any) {
    expect(init).toEqual({
      kind: 'abort_resolution',
      abortedContext,
      userText: 'next request',
      generation: 7,
    });
    yield { type: 'text_delta', delta: 'continuation text' };
    return {
      kind: 'response',
      terminal: { type: 'response', finalText: 'final response' },
    };
  };

  const result = await collect(workflow.executeInitial('next request'));
  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'initial text' },
    { type: 'text_delta', delta: 'continuation text' },
  ]);
  expect(result.outcome).toEqual({
    kind: 'response',
    terminal: { type: 'response', finalText: 'final response' },
  });
});

it('executeInitial auto-approves shell approvals', async () => {
  const { workflow } = setupWorkflow(null);

  (workflow as any).executeInitialAttempt = async function* () {
    yield { type: 'text_delta', delta: 'initial text' };
    return {
      kind: 'auto_approval_required',
      generation: 5,
      callId: 'call-1',
      command: 'echo ok',
    };
  };

  (workflow as any).executeContinuationAttempt = async function* (init: any) {
    expect(init).toEqual({
      kind: 'approval_decision',
      answer: 'y',
      generation: 5,
    });
    yield { type: 'text_delta', delta: 'auto-approving' };
    return {
      kind: 'response',
      terminal: { type: 'response', finalText: 'auto-approved response' },
    };
  };

  const result = await collect(workflow.executeInitial('run command'));
  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'initial text' },
    { type: 'text_delta', delta: 'auto-approving' },
  ]);
  expect(result.outcome).toEqual({
    kind: 'response',
    terminal: { type: 'response', finalText: 'auto-approved response' },
  });
});

it('executeInitial redrives initial execution when continuation requests a fresh start', async () => {
  const { workflow } = setupWorkflow(null);
  let initialAttemptCount = 0;

  (workflow as any).executeInitialAttempt = async function* (input: any, options: any) {
    initialAttemptCount++;
    if (initialAttemptCount === 1) {
      expect(input).toBe('run command');
      yield { type: 'text_delta', delta: 'attempt 1' };
      return {
        kind: 'auto_approval_required',
        generation: 9,
      };
    } else {
      expect(input).toEqual({ text: '' });
      expect(options).toEqual({
        skipUserMessage: true,
        retries: {
          transientRetryCount: 1,
          serviceTierFallbackCount: 0,
          modelRetryCount: 0,
          transportDowngradeCount: 0,
        },
        delayMs: 25,
        useStandardServiceTier: true,
        token: 9,
        replayFromHistory: true,
      });
      yield { type: 'text_delta', delta: 'attempt 2' };
      return {
        kind: 'response',
        terminal: { type: 'response', finalText: 'recovered' },
      };
    }
  };

  (workflow as any).executeContinuationAttempt = async function* () {
    yield { type: 'text_delta', delta: 'continuation' };
    return {
      kind: 'fresh_start_required',
      retryCounts: {
        transientRetryCount: 1,
        serviceTierFallbackCount: 0,
        modelRetryCount: 0,
        transportDowngradeCount: 0,
      },
      delayMs: 25,
      useStandardServiceTier: true,
    };
  };

  const result = await collect(workflow.executeInitial('run command'));
  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'attempt 1' },
    { type: 'text_delta', delta: 'continuation' },
    { type: 'text_delta', delta: 'attempt 2' },
  ]);
  expect(result.outcome).toEqual({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered' },
  });
});

it('executeContinuation redrives initial execution when recovery requests a fresh start', async () => {
  const { workflow } = setupWorkflow(null);

  (workflow as any).executeContinuationAttempt = async function* () {
    yield { type: 'text_delta', delta: 'continuation fail' };
    return {
      kind: 'fresh_start_required',
      retryCounts: {
        transientRetryCount: 2,
        serviceTierFallbackCount: 0,
        modelRetryCount: 0,
        transportDowngradeCount: 0,
      },
      delayMs: 50,
    };
  };

  (workflow as any).executeInitialAttempt = async function* (input: any, options: any) {
    expect(input).toEqual({ text: '' });
    expect(options).toEqual({
      skipUserMessage: true,
      retries: { transientRetryCount: 2, serviceTierFallbackCount: 0, modelRetryCount: 0, transportDowngradeCount: 0 },
      delayMs: 50,
      token: 11,
      replayFromHistory: true,
    });
    yield { type: 'text_delta', delta: 'initial recovered' };
    return {
      kind: 'response',
      terminal: { type: 'response', finalText: 'recovered' },
    };
  };

  const result = await collect(
    workflow.executeContinuation({
      kind: 'approval_decision',
      answer: 'y',
      generation: 11,
    }),
  );

  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'continuation fail' },
    { type: 'text_delta', delta: 'initial recovered' },
  ]);
  expect(result.outcome).toEqual({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered' },
  });
});
