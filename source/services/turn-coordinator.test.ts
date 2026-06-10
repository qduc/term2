import test from 'ava';
import { TurnCoordinator } from './turn-coordinator.js';
import { TurnStatusMachine } from './turn-status-machine.js';

const makeHarness = () => {
  const statusMachine = new TurnStatusMachine();

  let initialRunnerResults: any[] = [];
  const initialTurnRunner = {
    run: async function* (_input: any, _options: any) {
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
      return result?.outcome ?? { kind: 'response', result: { type: 'response', finalText: 'done' } };
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
  });

  return {
    coordinator,
    statusMachine,
    initialTurnRunner,
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
    result: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
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
    return { kind: 'response', result: { type: 'response', finalText: 'done' } };
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

test('Abort to idle with pending approval reconciliation', async (t) => {
  const { coordinator, statusMachine, getAbortCalled } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // awaiting_approval

  coordinator.abort();

  t.true(getAbortCalled());
  t.is(statusMachine.current, 'idle');
});
