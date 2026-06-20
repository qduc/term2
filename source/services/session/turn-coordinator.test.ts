import { it, expect } from 'vitest';
import { TurnCoordinator } from './turn-coordinator.js';
import { TurnStatusMachine } from './turn-status-machine.js';

const makeHarness = () => {
  const statusMachine = new TurnStatusMachine();

  const initialCalls: any[] = [];
  const continuationCalls: any[] = [];
  const initialResults: any[] = [];
  const continuationResults: any[] = [];
  const turnExecutor = {
    executeInitial: async function* (input: any, options: any) {
      initialCalls.push({ input, options });
      const result = initialResults.shift();
      if (result?.events) {
        for (const ev of result.events) {
          yield ev;
        }
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
    },
    executeContinuation: async function* (input: any) {
      continuationCalls.push(input);
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
    turnExecutor,
    approvalFlow,
  });

  return {
    coordinator,
    statusMachine,
    turnExecutor,
    initialCalls,
    continuationCalls,
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
  const { coordinator, statusMachine, turnExecutor } = makeHarness();
  turnExecutor.setNextInitialResult({
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
  const { coordinator, statusMachine, turnExecutor } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // status becomes 'awaiting_approval'

  turnExecutor.setNextContinuationResult({
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
  const { coordinator, statusMachine, turnExecutor } = makeHarness();

  let checkedStatusInLoop: any = null;

  turnExecutor.executeInitial = async function* () {
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
  const { coordinator, statusMachine, turnExecutor } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // status becomes 'awaiting_approval'

  let checkedStatusInLoop: any = null;

  turnExecutor.executeContinuation = async function* () {
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
  const { coordinator, statusMachine, turnExecutor } = makeHarness();
  turnExecutor.setNextInitialResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'complete' },
  });

  expect(statusMachine.current).toBe('idle');
  for await (const _ of coordinator.start('run command')) {
  }
  expect(statusMachine.current).toBe('idle');
});

it('failed completes the status because the runner already emitted terminal events', async () => {
  const { coordinator, statusMachine, turnExecutor } = makeHarness();
  turnExecutor.setNextInitialResult({
    kind: 'failed',
  });

  expect(statusMachine.current).toBe('idle');
  for await (const _ of coordinator.start('run command')) {
  }
  expect(statusMachine.current).toBe('idle');
});

it('stale leaves status untouched because lifecycle operation resolved it', async () => {
  const { coordinator, statusMachine, turnExecutor } = makeHarness();

  turnExecutor.executeInitial = async function* () {
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
  const { coordinator, turnExecutor } = makeHarness();
  turnExecutor.setNextInitialResult({
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
  const { coordinator, statusMachine, turnExecutor } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval();

  turnExecutor.executeContinuation = async function* () {
    statusMachine.abort();
    statusMachine.beginTurn();
    return { kind: 'stale' };
  };

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(statusMachine.current).toBe('streaming');
});

it('continueAfterApproval passes the pending generation to the executor', async () => {
  const { coordinator, statusMachine, turnExecutor, continuationCalls, approvalFlow } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval();
  approvalFlow.setPending({ token: 7 });
  turnExecutor.setNextContinuationResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'done' },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'n', rejectionReason: 'too risky' })) {
  }

  expect(continuationCalls).toEqual([{ answer: 'n', rejectionReason: 'too risky', generation: 7 }]);
  expect(statusMachine.current).toBe('idle');
});

it('continuation completion releases the turn for the next user message', async () => {
  const { coordinator, statusMachine, turnExecutor, approvalFlow } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval();
  approvalFlow.setPending({ token: 7 });
  turnExecutor.setNextContinuationResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered' },
  });

  for await (const _ of coordinator.continueAfterApproval({ answer: 'y' })) {
  }

  expect(statusMachine.current).toBe('idle');

  turnExecutor.setNextInitialResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'next turn' },
  });
  // Should not throw - this verifies the turn is released
  for await (const _ of coordinator.start('next message')) {
  }
});

it('Abort to idle with pending approval reconciliation', async () => {
  const { coordinator, statusMachine, getAbortCalled } = makeHarness();
  statusMachine.beginTurn();
  statusMachine.requestApproval(); // awaiting_approval

  coordinator.abort();

  expect(getAbortCalled()).toBe(true);
  expect(statusMachine.current).toBe('idle');
});
