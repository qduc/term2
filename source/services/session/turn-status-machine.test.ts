import { it, expect } from 'vitest';
import { TurnStatusMachine } from './turn-status-machine.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';

const terminalResponse: ConversationTerminal = {
  type: 'response',
  commandMessages: [],
  finalText: 'hello',
};

const terminalApproval: ConversationTerminal = {
  type: 'approval_required',
  approval: {
    agentName: 'test',
    toolName: 'shell',
    argumentsText: 'ls',
    rawInterruption: {},
  },
};

it('begins turn from idle', () => {
  const machine = new TurnStatusMachine();
  expect(machine.current).toBe('idle');
  machine.beginTurn();
  expect(machine.current).toBe('streaming');
});

it('beginTurn from non-idle throws', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();

  expect(() => machine.beginTurn()).toThrow(/Invalid transition.*streaming.*streaming/);
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

  expect(() => machine.requestApproval()).toThrow(/Cannot request approval from idle/);
  machine.beginTurn();
  machine.requestApproval();

  expect(() => machine.requestApproval()).toThrow(/Cannot request approval from awaiting_approval/);
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

  expect(() => machine.beginContinuation()).toThrow(/Invalid transition.*idle.*continuing/);
  machine.beginTurn();

  expect(() => machine.beginContinuation()).toThrow(/Invalid transition.*streaming.*continuing/);
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

it('completeOutcome emits response terminals and returns to idle', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();

  const command = machine.completeOutcome({ kind: 'response', terminal: terminalResponse });

  expect(machine.current).toBe('idle');
  expect(command).toEqual({ kind: 'emit_terminal', terminal: terminalResponse });
});

it('completeOutcome emits approval terminals and enters awaiting approval', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();

  const command = machine.completeOutcome({ kind: 'approval_required', terminal: terminalApproval });

  expect(machine.current).toBe('awaiting_approval');
  expect(command).toEqual({ kind: 'emit_terminal', terminal: terminalApproval });
});

it('completeOutcome leaves stale active status untouched', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();

  const command = machine.completeOutcome({ kind: 'stale' });

  expect(machine.current).toBe('streaming');
  expect(command).toEqual({ kind: 'none' });
});

it('completeOutcome returns failed active turns to idle without emitting', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();

  const command = machine.completeOutcome({ kind: 'failed' });

  expect(machine.current).toBe('idle');
  expect(command).toEqual({ kind: 'none' });
});

it('completeOutcome ignores stale outcomes after an external status change', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.abort();

  const command = machine.completeOutcome({ kind: 'stale' });

  expect(machine.current).toBe('idle');
  expect(command).toEqual({ kind: 'none' });
});

it('completeContinuationOutcome emits a response terminal even after an external status change', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  machine.abort();

  const command = machine.completeContinuationOutcome({ kind: 'response', terminal: terminalResponse });

  expect(machine.current).toBe('idle');
  expect(command).toEqual({ kind: 'emit_terminal', terminal: terminalResponse });
});

it('completeContinuationOutcome emits an approval terminal even after an external status change', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  machine.requestApproval();
  machine.beginContinuation();
  machine.abort();

  const command = machine.completeContinuationOutcome({ kind: 'approval_required', terminal: terminalApproval });

  expect(machine.current).toBe('idle');
  expect(command).toEqual({ kind: 'emit_terminal', terminal: terminalApproval });
});
