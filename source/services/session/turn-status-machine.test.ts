import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TurnStatusMachine } from './turn-status-machine.js';

it('begins turn from idle', () => {
  const machine = new TurnStatusMachine();
  expect(machine.current).toBe('idle');
  machine.beginTurn();
  expect(machine.current).toBe('streaming');
});

it('beginTurn from non-idle throws', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();

  expect(() => machine.beginTurn(), { message: /Invalid transition.*streaming.*streaming/ }).toThrow();
});

it('requestApproval from streaming succeeds', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  expect(machine.current).toBe('awaiting_approval');
});

it('requestApproval from continuing succeeds', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  machine.requestApproval();
  expect(machine.current).toBe('awaiting_approval');
});

it('requestApproval from idle or awaiting_approval throws', () => {
  const machine = new TurnStatusMachine();

  expect(() => machine.requestApproval(), { message: /Cannot request approval from idle/ }).toThrow();
  machine.beginTurn();
  machine.requestApproval();

  expect(() => machine.requestApproval(), { message: /Cannot request approval from awaiting_approval/ }).toThrow();
});

it('beginContinuation from awaiting_approval succeeds', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  expect(machine.current).toBe('continuing');
});

it('beginContinuation from non-awaiting_approval throws', () => {
  const machine = new TurnStatusMachine();

  expect(() => machine.beginContinuation(), { message: /Invalid transition.*idle.*continuing/ }).toThrow();
  machine.beginTurn();

  expect(() => machine.beginContinuation(), { message: /Invalid transition.*streaming.*continuing/ }).toThrow();
});

it('complete from streaming returns to idle', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.complete();
  expect(machine.current).toBe('idle');
});

it('complete from continuing returns to idle', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  machine.complete();
  expect(machine.current).toBe('idle');
});

it('complete from idle and awaiting_approval is a no-op', () => {
  const machine = new TurnStatusMachine();
  machine.complete();
  expect(machine.current).toBe('idle');
  machine.beginTurn();
  machine.requestApproval();
  machine.complete();
  expect(machine.current).toBe('awaiting_approval');
});

it('abort from any state returns to idle', () => {
  const machine = new TurnStatusMachine();
  machine.abort();
  expect(machine.current).toBe('idle');

  machine.beginTurn();
  machine.abort();
  expect(machine.current).toBe('idle');

  machine.beginTurn();
  machine.requestApproval();
  machine.abort();
  expect(machine.current).toBe('idle');

  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  machine.abort();
  expect(machine.current).toBe('idle');
});

it('is helper matches current status', () => {
  const machine = new TurnStatusMachine();
  expect(machine.is('idle')).toBe(true);
  machine.beginTurn();
  expect(machine.is('streaming')).toBe(true);
  expect(machine.is('idle')).toBe(false);
});
