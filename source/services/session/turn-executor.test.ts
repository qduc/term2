import { it, expect } from 'vitest';
import { DefaultTurnExecutor } from './turn-executor.js';

const defaultRetryCounts = {
  transientRetryCount: 1,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

const collect = async (iterable: AsyncGenerator<any, any, void>) => {
  const events: any[] = [];
  let next = await iterable.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterable.next();
  }
  return { events, outcome: next.value };
};

const makeHarness = () => {
  const initialResults: any[] = [];
  const initialCalls: any[] = [];
  const initialTurnRunner = {
    run: async function* (input: any, options: any) {
      initialCalls.push({ input, options });
      const result = initialResults.shift();
      for (const event of result?.events ?? []) {
        yield event;
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'initial done' } };
    },
  } as any;

  const continuationResults: any[] = [];
  const continuationCalls: any[] = [];
  const continuationDriver = {
    drive: async function* (init: any, policy?: any) {
      continuationCalls.push({ init, policy });
      const result = continuationResults.shift();
      for (const event of result?.events ?? []) {
        yield event;
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'continued' } };
    },
  } as any;

  const executor = new DefaultTurnExecutor({
    initialTurnRunner,
    continuationDriver,
    shellAutoApproval: {} as any,
  });

  return {
    executor,
    initialCalls,
    continuationCalls,
    enqueueInitial: (outcome: any, events: any[] = []) => initialResults.push({ outcome, events }),
    enqueueContinuation: (outcome: any, events: any[] = []) => continuationResults.push({ outcome, events }),
  };
};

it('executeInitial returns canonical outcomes and forwards streamed events', async () => {
  const { executor, enqueueInitial, initialCalls, continuationCalls } = makeHarness();
  enqueueInitial({ kind: 'response', terminal: { type: 'response', finalText: 'done' } }, [
    { type: 'text_delta', delta: 'hello' },
  ]);

  const result = await collect(executor.executeInitial('hi', { skipUserMessage: true }));

  expect(result.events).toEqual([{ type: 'text_delta', delta: 'hello' }]);
  expect(result.outcome).toEqual({ kind: 'response', terminal: { type: 'response', finalText: 'done' } });
  expect(initialCalls).toEqual([{ input: 'hi', options: { skipUserMessage: true } }]);
  expect(continuationCalls).toEqual([]);
});

it('executeInitial resolves aborted approvals through the continuation driver', async () => {
  const { executor, enqueueInitial, continuationCalls } = makeHarness();
  const abortedContext = { token: 7, interruption: { id: 'interrupt-1' } };
  enqueueInitial({ kind: 'abort_resolution_required', abortedContext, userText: 'next request', generation: 7 });

  const result = await collect(executor.executeInitial('next request', {}));

  expect(result.outcome).toEqual({ kind: 'response', terminal: { type: 'response', finalText: 'continued' } });
  expect(continuationCalls).toHaveLength(1);
  expect(continuationCalls[0]?.init).toEqual({
    kind: 'abort_resolution',
    abortedContext,
    userText: 'next request',
    generation: 7,
  });
  expect(continuationCalls[0]?.policy).toBeDefined();
});

it('executeInitial auto-approves shell approvals through the continuation driver', async () => {
  const { executor, enqueueInitial, continuationCalls } = makeHarness();
  enqueueInitial({ kind: 'auto_approval_required', generation: 5, callId: 'call-1', command: 'echo ok' });

  const result = await collect(executor.executeInitial('run command', {}));

  expect(result.outcome).toEqual({ kind: 'response', terminal: { type: 'response', finalText: 'continued' } });
  expect(continuationCalls[0]?.init).toEqual({ kind: 'approval_decision', answer: 'y', generation: 5 });
  expect(continuationCalls[0]?.policy).toBeDefined();
});

it('executeInitial redrives initial execution when continuation requests a fresh start', async () => {
  const { executor, enqueueInitial, enqueueContinuation, initialCalls } = makeHarness();
  enqueueInitial({ kind: 'auto_approval_required', generation: 9 });
  enqueueContinuation({
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
    delayMs: 25,
    useStandardServiceTier: true,
  });
  enqueueInitial({ kind: 'response', terminal: { type: 'response', finalText: 'recovered' } });

  const result = await collect(executor.executeInitial('run command', { maxModelRetries: 2 }));

  expect(result.outcome).toEqual({ kind: 'response', terminal: { type: 'response', finalText: 'recovered' } });
  expect(initialCalls).toEqual([
    { input: 'run command', options: { maxModelRetries: 2 } },
    {
      input: { text: '' },
      options: {
        skipUserMessage: true,
        retries: defaultRetryCounts,
        delayMs: 25,
        useStandardServiceTier: true,
        token: 9,
      },
    },
  ]);
});

it('executeContinuation redrives initial execution when recovery requests a fresh start', async () => {
  const { executor, enqueueContinuation, enqueueInitial, initialCalls, continuationCalls } = makeHarness();
  enqueueContinuation({ kind: 'fresh_start_required', retryCounts: defaultRetryCounts, delayMs: 50 });
  enqueueInitial({ kind: 'response', terminal: { type: 'response', finalText: 'recovered' } }, [
    { type: 'text_delta', delta: 'recovering' },
  ]);

  const result = await collect(
    executor.executeContinuation({ answer: 'y', rejectionReason: 'not needed', generation: 11 }),
  );

  expect(result.events).toEqual([{ type: 'text_delta', delta: 'recovering' }]);
  expect(result.outcome).toEqual({ kind: 'response', terminal: { type: 'response', finalText: 'recovered' } });
  expect(continuationCalls[0]?.init).toEqual({
    kind: 'approval_decision',
    answer: 'y',
    rejectionReason: 'not needed',
    generation: 11,
  });
  expect(initialCalls[0]).toEqual({
    input: { text: '' },
    options: { skipUserMessage: true, retries: defaultRetryCounts, delayMs: 50, token: 11 },
  });
});

it('executeContinuation returns non-redrive outcomes directly', async () => {
  const { executor, enqueueContinuation, initialCalls } = makeHarness();
  enqueueContinuation({
    kind: 'approval_required',
    terminal: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
  });

  const result = await collect(executor.executeContinuation({ answer: 'n', generation: 3 }));

  expect(result.outcome).toEqual({
    kind: 'approval_required',
    terminal: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
  });
  expect(initialCalls).toEqual([]);
});

it('preserves event order across continuation and redriven initial execution', async () => {
  const { executor, enqueueContinuation, enqueueInitial } = makeHarness();
  enqueueContinuation({ kind: 'fresh_start_required', retryCounts: defaultRetryCounts }, [
    { type: 'text_delta', delta: 'before' },
  ]);
  enqueueInitial({ kind: 'response', terminal: { type: 'response', finalText: 'done' } }, [
    { type: 'text_delta', delta: 'after' },
  ]);

  const result = await collect(executor.executeContinuation({ answer: 'y', generation: 4 }));

  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'before' },
    { type: 'text_delta', delta: 'after' },
  ]);
});
