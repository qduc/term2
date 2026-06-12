import test from 'ava';
import { TurnStatusMachine } from './turn-status-machine.js';

test('begins turn from idle', (t) => {
  const machine = new TurnStatusMachine();
  t.is(machine.current, 'idle');
  machine.beginTurn();
  t.is(machine.current, 'streaming');
});

test('beginTurn from non-idle throws', (t) => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  t.throws(() => machine.beginTurn(), { message: /Invalid transition.*streaming.*streaming/ });
});

test('requestApproval from streaming succeeds', (t) => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  t.is(machine.current, 'awaiting_approval');
});

test('requestApproval from continuing succeeds', (t) => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  machine.requestApproval();
  t.is(machine.current, 'awaiting_approval');
});

test('requestApproval from idle or awaiting_approval throws', (t) => {
  const machine = new TurnStatusMachine();
  t.throws(() => machine.requestApproval(), { message: /Cannot request approval from idle/ });
  machine.beginTurn();
  machine.requestApproval();
  t.throws(() => machine.requestApproval(), { message: /Cannot request approval from awaiting_approval/ });
});

test('beginContinuation from awaiting_approval succeeds', (t) => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  t.is(machine.current, 'continuing');
});

test('beginContinuation from non-awaiting_approval throws', (t) => {
  const machine = new TurnStatusMachine();
  t.throws(() => machine.beginContinuation(), { message: /Invalid transition.*idle.*continuing/ });
  machine.beginTurn();
  t.throws(() => machine.beginContinuation(), { message: /Invalid transition.*streaming.*continuing/ });
});

test('complete from streaming returns to idle', (t) => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.complete();
  t.is(machine.current, 'idle');
});

test('complete from continuing returns to idle', (t) => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  machine.complete();
  t.is(machine.current, 'idle');
});

test('complete from idle and awaiting_approval is a no-op', (t) => {
  const machine = new TurnStatusMachine();
  machine.complete();
  t.is(machine.current, 'idle');
  machine.beginTurn();
  machine.requestApproval();
  machine.complete();
  t.is(machine.current, 'awaiting_approval');
});

test('abort from any state returns to idle', (t) => {
  const machine = new TurnStatusMachine();
  machine.abort();
  t.is(machine.current, 'idle');

  machine.beginTurn();
  machine.abort();
  t.is(machine.current, 'idle');

  machine.beginTurn();
  machine.requestApproval();
  machine.abort();
  t.is(machine.current, 'idle');

  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  machine.abort();
  t.is(machine.current, 'idle');
});

test('is helper matches current status', (t) => {
  const machine = new TurnStatusMachine();
  t.true(machine.is('idle'));
  machine.beginTurn();
  t.true(machine.is('streaming'));
  t.false(machine.is('idle'));
});
