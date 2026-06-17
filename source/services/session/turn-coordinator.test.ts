import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TurnCoordinator } from './turn-coordinator.js';
import { TurnStatusMachine } from './turn-status-machine.js';

const makeHarness = () => {
  const statusMachine = new TurnStatusMachine();

  let initialRunnerResults: any[] = [];
  const initialRunnerCalls: any[] = [];
  const initialTurnRunner = {
    run: async function* (input: any, options: any) {
      initialRunnerCalls.push({ input, options });
      const result = initialRunnerResults.shift();
      if (result?.events) {
        for (const ev of result.events) {
          yield ev;
        }
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
    },
    setNextResult: (outcome: any, events: any[] = []) => {
      initialRunnerResults.push({ outcome, events });
    },
  } as any;

  let driveResults: any[] = [];
  const continuationDriverCalls: any[] = [];
  const continuationDriver = {
    drive: async function* (init: any) {
      continuationDriverCalls.push(init);
      const result = driveResults.shift();
      if (result?.events) {
        for (const ev of result.events) {
          yield ev;
        }
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
    },
    setNextResult: (outcome: any, events: any[] = []) => {
      driveResults.push({ outcome, events });
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
    getPending: () => getPendingResult,
    setPending: (p: any) => {
      getPendingResult = p;
    },
  } as any;

  const coordinator = new TurnCoordinator({
    statusMachine,
    initialTurnRunner,
    continuationDriver,
    approvalFlow,
    shellAutoApproval: {} as any,
  });

  return {
    coordinator,
    statusMachine,
    initialTurnRunner,
    initialRunnerCalls,
    continuationDriver,
    continuationDriverCalls,
    approvalFlow,
    getAbortCalled: () => abortCalled,
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

it('streaming -> awaiting_approval', async () => {
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();
  initialTurnRunner.setNextResult({
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

it('awaiting_approval -> continuing -> awaiting_approval', async () => {
  const { coordinator, statusMachine, continuationDriver } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // status becomes 'awaiting_approval'

  continuationDriver.setNextResult({
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
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();

  let checkedStatusInLoop: any = null;

  initialTurnRunner.run = async function* () {
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
  const { coordinator, statusMachine, continuationDriver } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // status becomes 'awaiting_approval'

  let checkedStatusInLoop: any = null;

  continuationDriver.drive = async function* () {
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
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();
  initialTurnRunner.setNextResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'complete' },
  });

  expect(statusMachine.current).toBe('idle');
  for await (const _ of coordinator.start('run command')) {
  }
  expect(statusMachine.current).toBe('idle');
});

it('failed completes the status because the runner already emitted terminal events', async () => {
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();
  initialTurnRunner.setNextResult({
    kind: 'failed',
  });

  expect(statusMachine.current).toBe('idle');
  for await (const _ of coordinator.start('run command')) {
  }
  expect(statusMachine.current).toBe('idle');
});

it('stale leaves status untouched because lifecycle operation resolved it', async () => {
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();

  initialTurnRunner.run = async function* () {
    // during the run, concurrent operation invalidates and starts new turn
    statusMachine.complete(); // back to idle
    statusMachine.beginTurn(); // new turn streaming
    return { kind: 'stale' };
  };

  expect(statusMachine.current).toBe('idle');
  for await (const _ of coordinator.start('run command')) {
  }
  expect(statusMachine.current).toBe('streaming'); // remains streaming
});

it('stale initial outcome does not emit a terminal event', async () => {
  const { coordinator, initialTurnRunner } = makeHarness();
  initialTurnRunner.setNextResult({
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
  const { coordinator, statusMachine, continuationDriver } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval();

  continuationDriver.drive = async function* () {
    statusMachine.abort();
    statusMachine.beginTurn();
    return { kind: 'stale' };
  };

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(statusMachine.current).toBe('streaming');
});

it('fresh-start continuation forwards recovery instructions to the initial runner', async () => {
  const { coordinator, statusMachine, continuationDriver, initialTurnRunner, initialRunnerCalls, approvalFlow } =
    makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval();
  approvalFlow.setPending({ token: 7 });
  continuationDriver.setNextResult({
    kind: 'fresh_start_required',
    retryCounts: {
      transientRetryCount: 1,
      serviceTierFallbackCount: 1,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
    delayMs: 125,
    useStandardServiceTier: true,
  });
  initialTurnRunner.setNextResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered' },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(initialRunnerCalls[0]?.options).toMatchObject({
    token: 7,
    delayMs: 125,
    useStandardServiceTier: true,
  });
  expect(statusMachine.current).toBe('idle');
});

it('fresh-start completion releases the turn for the next user message', async () => {
  const { coordinator, statusMachine, continuationDriver, initialTurnRunner, approvalFlow } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval();
  approvalFlow.setPending({ token: 7 });
  continuationDriver.setNextResult({
    kind: 'fresh_start_required',
    retryCounts: {
      transientRetryCount: 1,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
  });
  initialTurnRunner.setNextResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered' },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(statusMachine.current).toBe('idle');

  initialTurnRunner.setNextResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'next turn' },
  });
  // Should not throw - this verifies the turn is released
  for await (const _ of coordinator.start('next message')) {
  }
});

it('fresh-start auto-approval is driven before the recovered turn completes', async () => {
  const { coordinator, statusMachine, continuationDriver, continuationDriverCalls, initialTurnRunner, approvalFlow } =
    makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval();
  approvalFlow.setPending({ token: 7 });
  continuationDriver.setNextResult({
    kind: 'fresh_start_required',
    retryCounts: {
      transientRetryCount: 1,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
  });
  initialTurnRunner.setNextResult({
    kind: 'auto_approval_required',
    generation: 7,
    callId: 'call-recovered',
    command: 'echo recovered',
  });
  continuationDriver.setNextResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered after approval' },
  });

  const events: any[] = [];
  for await (const event of coordinator.continueAfterApproval({ answer: 'y' })) {
    events.push(event);
  }

  expect(continuationDriverCalls.length).toBe(2);
  expect(continuationDriverCalls[1]).toEqual({
    kind: 'approval_decision',
    answer: 'y',
    generation: 7,
  });
  expect(events.at(-1)?.type).toBe('final');
  expect(events.at(-1)?.finalText).toBe('recovered after approval');
  expect(statusMachine.current).toBe('idle');
});

it('Abort to idle with pending approval reconciliation', async () => {
  const { coordinator, statusMachine, getAbortCalled } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // awaiting_approval

  coordinator.abort();

  expect(getAbortCalled()).toBe(true);
  expect(statusMachine.current).toBe('idle');
});
