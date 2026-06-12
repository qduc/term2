import test from 'ava';
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
  const continuationDriver = {
    drive: async function* (_init: any) {
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
    approvalFlow,
    getAbortCalled: () => abortCalled,
  };
};

test('Foreground-turn admission: throws when already active', async (t) => {
  const { coordinator, statusMachine } = makeHarness();
  statusMachine.beginTurn(); // status becomes 'streaming'

  await t.throwsAsync(
    async () => {
      for await (const _ of coordinator.start('hello')) {
      }
    },
    { message: 'Another foreground turn is already active.' },
  );
});

test('streaming -> awaiting_approval', async (t) => {
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();
  initialTurnRunner.setNextResult({
    kind: 'approval_required',
    terminal: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
  });

  t.is(statusMachine.current, 'idle');
  const events: any[] = [];
  for await (const ev of coordinator.start('run command')) {
    events.push(ev);
  }

  t.is(statusMachine.current, 'awaiting_approval');
  t.is(events.length, 1);
  t.is(events[0].type, 'approval_required');
});

test('awaiting_approval -> continuing -> awaiting_approval', async (t) => {
  const { coordinator, statusMachine, continuationDriver } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // status becomes 'awaiting_approval'

  continuationDriver.setNextResult({
    kind: 'approval_required',
    terminal: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
  });

  t.is(statusMachine.current, 'awaiting_approval');
  const events: any[] = [];
  for await (const ev of coordinator.continueAfterApproval({ answer: 'y' })) {
    events.push(ev);
  }

  t.is(statusMachine.current, 'awaiting_approval');
  t.is(events.length, 1);
  t.is(events[0].type, 'approval_required');
});

test('Auto-approved initial continuations leave status streaming', async (t) => {
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();

  let checkedStatusInLoop: any = null;

  initialTurnRunner.run = async function* () {
    checkedStatusInLoop = statusMachine.current;
    yield { type: 'text_delta', delta: 'Running...' };
    return { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
  };

  for await (const _ of coordinator.start('run command')) {
  }

  t.is(checkedStatusInLoop, 'streaming');
  t.is(statusMachine.current, 'idle');
});

test('Auto-approved manual continuations leave status continuing', async (t) => {
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

  t.is(checkedStatusInLoop, 'continuing');
  t.is(statusMachine.current, 'idle');
});

test('Terminal completion to idle', async (t) => {
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();
  initialTurnRunner.setNextResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'complete' },
  });

  t.is(statusMachine.current, 'idle');
  for await (const _ of coordinator.start('run command')) {
  }
  t.is(statusMachine.current, 'idle');
});

test('failed completes the status because the runner already emitted terminal events', async (t) => {
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();
  initialTurnRunner.setNextResult({
    kind: 'failed',
  });

  t.is(statusMachine.current, 'idle');
  for await (const _ of coordinator.start('run command')) {
  }
  t.is(statusMachine.current, 'idle');
});

test('stale leaves status untouched because lifecycle operation resolved it', async (t) => {
  const { coordinator, statusMachine, initialTurnRunner } = makeHarness();

  initialTurnRunner.run = async function* () {
    // during the run, concurrent operation invalidates and starts new turn
    statusMachine.complete(); // back to idle
    statusMachine.beginTurn(); // new turn streaming
    return { kind: 'stale' };
  };

  t.is(statusMachine.current, 'idle');
  for await (const _ of coordinator.start('run command')) {
  }
  t.is(statusMachine.current, 'streaming'); // remains streaming
});

test('stale initial outcome does not emit a terminal event', async (t) => {
  const { coordinator, initialTurnRunner } = makeHarness();
  initialTurnRunner.setNextResult({
    kind: 'stale',
    terminal: { type: 'response', finalText: 'stale response' },
  });

  const events: any[] = [];
  for await (const event of coordinator.start('run command')) {
    events.push(event);
  }

  t.deepEqual(events, []);
});

test('stale continuation leaves a newer turn status untouched', async (t) => {
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

  t.is(statusMachine.current, 'streaming');
});

test('fresh-start continuation forwards recovery instructions to the initial runner', async (t) => {
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

  t.like(initialRunnerCalls[0]?.options, {
    token: 7,
    delayMs: 125,
    useStandardServiceTier: true,
  });
});

test('Abort to idle with pending approval reconciliation', async (t) => {
  const { coordinator, statusMachine, getAbortCalled } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // awaiting_approval

  coordinator.abort();

  t.true(getAbortCalled());
  t.is(statusMachine.current, 'idle');
});
