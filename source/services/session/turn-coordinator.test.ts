import { it, expect } from 'vitest';
import { TurnCoordinator } from './turn-coordinator.js';
import { TurnStatusMachine } from './turn-status-machine.js';

const makeHarness = () => {
  const statusMachine = new TurnStatusMachine();

  const initialCalls: any[] = [];
  const continuationCalls: any[] = [];
  const initialResults: any[] = [];
  const continuationResults: any[] = [];
  const turnScope: string[] = [];
  let liveRunAborted = false;
  const turnWorkflow = {
    openTurn: () => turnScope.push('open'),
    closeTurn: () => turnScope.push('close'),
    executeInitial: async function* (input: any, options: any) {
      turnScope.push('executeInitial');
      initialCalls.push({ input, options });
      const result = initialResults.shift();
      if (result?.events) {
        for (const ev of result.events) {
          yield ev;
        }
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
    },
    executeContinuation: async function* (init: any) {
      turnScope.push('executeContinuation');
      continuationCalls.push(init);
      const result = continuationResults.shift();
      if (result?.events) {
        for (const ev of result.events) {
          yield ev;
        }
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
    },
    setNextInitialResult: (outcome: any, events: any[] = []) => {
      initialResults.push({ outcome, events });
    },
    setNextContinuationResult: (outcome: any, events: any[] = []) => {
      continuationResults.push({ outcome, events });
    },
    abortLiveRun: () => {
      liveRunAborted = true;
    },
  } as any;

  let abortCalled = false;
  let getPendingResult: any = null;
  const approvalFlow = {
    consumeAborted: () => null,
    getAbortedStatus: () => ({ kind: 'none' }),
    abort: () => {
      abortCalled = true;
      return { aborted: true, callId: 'call-1' };
    },
    buildApprovalDecision: (answer: string, rejectionReason?: string) => ({
      kind: 'approval_decision',
      answer,
      rejectionReason,
      generation: getPendingResult?.token ?? 0,
    }),
    getPending: () => getPendingResult,
    setPending: (p: any) => {
      getPendingResult = p;
    },
  } as any;

  let providerContinuityCleared = false;
  const providerContinuity = {
    clear: () => {
      providerContinuityCleared = true;
    },
  } as any;

  const manualDecisions: Array<{ command: string; decision: string }> = [];
  const shellAutoApproval = {
    recordManualDecision: (command: string, decision: 'approved' | 'rejected') => {
      manualDecisions.push({ command, decision });
    },
  } as any;

  const coordinator = new TurnCoordinator({
    statusMachine,
    turnWorkflow,
    approvalFlow,
    providerContinuity,
    shellAutoApproval,
  });

  return {
    coordinator,
    statusMachine,
    turnWorkflow,
    initialCalls,
    continuationCalls,
    turnScope,
    approvalFlow,
    manualDecisions,
    getAbortCalled: () => abortCalled,
    getLiveRunAborted: () => liveRunAborted,
    getProviderContinuityCleared: () => providerContinuityCleared,
  };
};

it('Foreground-turn admission: throws when already active', async () => {
  const { coordinator, statusMachine } = makeHarness();
  statusMachine.beginTurn(); // status becomes 'streaming'

  await expect(async () => {
    for await (const _ of coordinator.start('hello')) {
    }
  }).rejects.toThrow('Another foreground turn is already active.');
});

it('start forwards turn start options to the workflow', async () => {
  const { coordinator, initialCalls } = makeHarness();
  const options = {
    skipUserMessage: true,
    replayFromHistory: true,
    retries: { transientRetryCount: 2 },
    maxModelRetries: 3,
    signal: new AbortController().signal,
    resumeState: { state: 'resume' } as any,
    resumePreviousResponseId: 'resp-1',
    bypassInputSurgeGuard: true,
  };

  for await (const _ of coordinator.start('hello', options)) {
  }

  expect(initialCalls).toEqual([{ input: 'hello', options }]);
});

it('opens the turn scope before the workflow runs and closes it when the turn ends', async () => {
  // The scope has to be open before executeInitial, not after: the gap it
  // exists to cover — hooks, input preparation, provider start-up — is all
  // inside that call, ahead of the first request.
  const { coordinator, turnScope } = makeHarness();

  for await (const _ of coordinator.start('hello')) {
  }

  expect(turnScope).toEqual(['open', 'executeInitial', 'close']);
});

it('holds the turn scope open across an approval pause', async () => {
  // A turn parked on an approval is paused, not over. Closing the scope here
  // would release a steer the resumed segment was about to admit.
  const { coordinator, turnWorkflow, turnScope } = makeHarness();
  turnWorkflow.setNextInitialResult({
    kind: 'approval_required',
    terminal: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
  });

  for await (const _ of coordinator.start('run command')) {
  }
  expect(turnScope).toEqual(['open', 'executeInitial']);

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }
  expect(turnScope).toEqual(['open', 'executeInitial', 'executeContinuation', 'close']);
});

it('closes the turn scope when the turn is aborted', async () => {
  const { coordinator, turnScope } = makeHarness();
  turnScope.length = 0;

  coordinator.abort();

  expect(turnScope).toEqual(['close']);
});

it('streaming -> awaiting_approval', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();
  turnWorkflow.setNextInitialResult({
    kind: 'approval_required',
    terminal: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
  });

  expect(statusMachine.current).toBe('idle');
  const events: any[] = [];
  for await (const ev of coordinator.start('run command')) {
    events.push(ev);
  }

  expect(statusMachine.current).toBe('awaiting_approval');
  expect(events.length).toBe(1);
  expect(events[0].type).toBe('approval_required');
});

it('records the human decision for a shell approval before continuing', async () => {
  const { coordinator, statusMachine, approvalFlow, manualDecisions } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease);
  approvalFlow.setPending({
    interruption: { name: 'shell', arguments: JSON.stringify({ command: 'rm -rf ./dist' }) },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(manualDecisions).toEqual([{ command: 'rm -rf ./dist', decision: 'approved' }]);
});

it('records a rejection for a shell approval', async () => {
  const { coordinator, statusMachine, approvalFlow, manualDecisions } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease);
  approvalFlow.setPending({
    interruption: { name: 'shell', arguments: JSON.stringify({ command: 'git push --force' }) },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'n' })) {
  }

  expect(manualDecisions).toEqual([{ command: 'git push --force', decision: 'rejected' }]);
});

it('does not record a decision for a non-shell tool approval', async () => {
  const { coordinator, statusMachine, approvalFlow, manualDecisions } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease);
  approvalFlow.setPending({
    interruption: { name: 'write_file', arguments: JSON.stringify({ path: 'a.ts' }) },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(manualDecisions).toEqual([]);
});

it('awaiting_approval -> continuing -> awaiting_approval', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease); // status becomes 'awaiting_approval'

  turnWorkflow.setNextContinuationResult({
    kind: 'approval_required',
    terminal: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
  });

  expect(statusMachine.current).toBe('awaiting_approval');
  const events: any[] = [];
  for await (const ev of coordinator.continueAfterApproval({ answer: 'y' })) {
    events.push(ev);
  }

  expect(statusMachine.current).toBe('awaiting_approval');
  expect(events.length).toBe(1);
  expect(events[0].type).toBe('approval_required');
});

it('Auto-approved initial continuations leave status streaming', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();

  let checkedStatusInLoop: any = null;

  turnWorkflow.executeInitial = async function* () {
    checkedStatusInLoop = statusMachine.current;
    yield { type: 'text_delta', delta: 'Running...' };
    return { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
  };

  for await (const _ of coordinator.start('run command')) {
  }

  expect(checkedStatusInLoop).toBe('streaming');
  expect(statusMachine.current).toBe('idle');
});

it('Auto-approved manual continuations leave status continuing', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease); // status becomes 'awaiting_approval'

  let checkedStatusInLoop: any = null;

  turnWorkflow.executeContinuation = async function* () {
    checkedStatusInLoop = statusMachine.current;
    yield { type: 'text_delta', delta: 'Running...' };
    return { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
  };

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(checkedStatusInLoop).toBe('continuing');
  expect(statusMachine.current).toBe('idle');
});

it('Terminal completion to idle', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();
  turnWorkflow.setNextInitialResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'complete' },
  });

  expect(statusMachine.current).toBe('idle');
  for await (const _ of coordinator.start('run command')) {
  }
  expect(statusMachine.current).toBe('idle');
});

it('failed completes the status because the runner already emitted terminal events', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();
  turnWorkflow.setNextInitialResult({
    kind: 'failed',
  });

  expect(statusMachine.current).toBe('idle');
  for await (const _ of coordinator.start('run command')) {
  }
  expect(statusMachine.current).toBe('idle');
});

it('stale leaves status untouched because lifecycle operation resolved it', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();

  turnWorkflow.executeInitial = async function* () {
    // during the run, concurrent operation invalidates and starts new turn
    statusMachine.abort(); // back to idle and revoke the old turn
    statusMachine.beginTurn(); // new turn streaming
    yield* [];
    return { kind: 'stale' };
  };

  expect(statusMachine.current).toBe('idle');
  for await (const _ of coordinator.start('run command')) {
  }
  expect(statusMachine.current).toBe('streaming'); // remains streaming
});

it('stale initial outcome does not emit a terminal event', async () => {
  const { coordinator, turnWorkflow } = makeHarness();
  turnWorkflow.setNextInitialResult({
    kind: 'stale',
    terminal: { type: 'response', finalText: 'stale response' },
  });

  const events: any[] = [];
  for await (const event of coordinator.start('run command')) {
    events.push(event);
  }

  expect(events).toEqual([]);
});

it('stale continuation leaves a newer turn status untouched', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease);

  turnWorkflow.executeContinuation = async function* () {
    statusMachine.abort();
    statusMachine.beginTurn();
    yield* [];
    return { kind: 'stale' };
  };

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(statusMachine.current).toBe('streaming');
});

it('continueAfterApproval passes the pending generation to the executor', async () => {
  const { coordinator, statusMachine, turnWorkflow, continuationCalls, approvalFlow } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease);
  approvalFlow.setPending({ token: 7 });
  turnWorkflow.setNextContinuationResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'done' },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'n', rejectionReason: 'too risky' })) {
  }

  expect(continuationCalls).toEqual([
    {
      kind: 'approval_decision',
      answer: 'n',
      rejectionReason: 'too risky',
      generation: 7,
    },
  ]);
  expect(statusMachine.current).toBe('idle');
});

it('continuation completion releases the turn for the next user message', async () => {
  const { coordinator, statusMachine, turnWorkflow, approvalFlow } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease);
  approvalFlow.setPending({ token: 7 });
  turnWorkflow.setNextContinuationResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered' },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(statusMachine.current).toBe('idle');

  turnWorkflow.setNextInitialResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'next turn' },
  });
  // Should not throw - this verifies the turn is released
  for await (const _ of coordinator.start('next message')) {
  }
});

it('late completion from an aborted turn cannot complete or emit for a newer turn', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();
  let releaseFirst!: () => void;
  const firstCanComplete = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstReachedBuffer!: () => void;
  const firstBuffered = new Promise<void>((resolve) => {
    firstReachedBuffer = resolve;
  });
  let invocation = 0;

  turnWorkflow.executeInitial = async function* () {
    invocation += 1;
    if (invocation === 1) {
      firstReachedBuffer();
      await firstCanComplete;
      return { kind: 'response', terminal: { type: 'response', finalText: 'turn A' } };
    }
    await new Promise<void>(() => {});
    return { kind: 'response', terminal: { type: 'response', finalText: 'turn B' } };
  };

  const turnA = coordinator.start('A')[Symbol.asyncIterator]();
  const turnACompletion = turnA.next();
  await firstBuffered;
  coordinator.abort();

  const turnB = coordinator.start('B')[Symbol.asyncIterator]();
  const turnBPending = turnB.next();
  expect(statusMachine.current).toBe('streaming');

  releaseFirst();
  const lateA = await turnACompletion;

  expect(lateA).toEqual({ done: true, value: undefined });
  expect(statusMachine.current).toBe('streaming');
  void turnBPending;
});

it('late intermediate events from an aborted turn are not forwarded into a newer turn', async () => {
  const { coordinator, statusMachine, turnWorkflow } = makeHarness();
  let releaseFirst!: () => void;
  const firstCanEmit = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstIsRunning = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let invocation = 0;

  turnWorkflow.executeInitial = async function* () {
    invocation += 1;
    if (invocation === 1) {
      firstStarted();
      await firstCanEmit;
      yield { type: 'text_delta', delta: 'late A text' };
      return { kind: 'response', terminal: { type: 'response', finalText: 'turn A' } };
    }
    await new Promise<void>(() => {});
    return { kind: 'response', terminal: { type: 'response', finalText: 'turn B' } };
  };

  const turnA = coordinator.start('A')[Symbol.asyncIterator]();
  const turnAEvent = turnA.next();
  await firstIsRunning;
  coordinator.abort();

  const turnB = coordinator.start('B')[Symbol.asyncIterator]();
  const turnBPending = turnB.next();
  releaseFirst();

  expect(await turnAEvent).toEqual({ done: true, value: undefined });
  expect(statusMachine.current).toBe('streaming');
  void turnBPending;
});

it('Abort to idle with pending approval reconciliation', async () => {
  const { coordinator, statusMachine, getAbortCalled, getLiveRunAborted, getProviderContinuityCleared } = makeHarness();
  const lease = statusMachine.beginTurn();
  statusMachine.requestApproval(lease); // awaiting_approval

  coordinator.abort();

  expect(getLiveRunAborted()).toBe(true);
  expect(getAbortCalled()).toBe(true);
  expect(getProviderContinuityCleared()).toBe(true);
  expect(statusMachine.current).toBe('idle');
});
