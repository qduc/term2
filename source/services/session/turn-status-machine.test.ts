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

it('begins turn from idle and returns its ownership lease', () => {
  const machine = new TurnStatusMachine();
  const lease = machine.beginTurn();
  expect(machine.current).toBe('streaming');
  expect(machine.owns(lease)).toBe(true);
});

it('beginTurn from non-idle throws', () => {
  const machine = new TurnStatusMachine();
  machine.beginTurn();
  expect(() => machine.beginTurn()).toThrow(/Invalid transition.*streaming.*streaming/);
});

it('requestApproval transitions streaming and continuing for the owner', () => {
  const machine = new TurnStatusMachine();
  const lease = machine.beginTurn();
  machine.requestApproval(lease);
  expect(machine.current).toBe('awaiting_approval');
  expect(machine.beginContinuation()).toBe(lease);
  machine.requestApproval(lease);
  expect(machine.current).toBe('awaiting_approval');
});

it('requestApproval rejects invalid owner phases', () => {
  const machine = new TurnStatusMachine();
  const lease = machine.beginTurn();
  machine.requestApproval(lease);
  expect(() => machine.requestApproval(lease)).toThrow(/Cannot request approval from awaiting_approval/);
});

it('beginContinuation from non-awaiting_approval throws', () => {
  const machine = new TurnStatusMachine();
  expect(() => machine.beginContinuation()).toThrow(/Invalid transition.*idle.*continuing/);
  machine.beginTurn();
  expect(() => machine.beginContinuation()).toThrow(/Invalid transition.*streaming.*continuing/);
});

it('complete returns streaming and continuing owner phases to idle', () => {
  const streaming = new TurnStatusMachine();
  const streamingLease = streaming.beginTurn();
  streaming.complete(streamingLease);
  expect(streaming.current).toBe('idle');

  const continuing = new TurnStatusMachine();
  const continuingLease = continuing.beginTurn();
  continuing.requestApproval(continuingLease);
  continuing.beginContinuation();
  continuing.complete(continuingLease);
  expect(continuing.current).toBe('idle');
});

it('complete from awaiting approval is a no-op', () => {
  const machine = new TurnStatusMachine();
  const lease = machine.beginTurn();
  machine.requestApproval(lease);
  machine.complete(lease);
  expect(machine.current).toBe('awaiting_approval');
});

it('abort from every active state returns to idle and revokes ownership', () => {
  for (const phase of ['streaming', 'awaiting_approval', 'continuing'] as const) {
    const machine = new TurnStatusMachine();
    const lease = machine.beginTurn();
    if (phase !== 'streaming') machine.requestApproval(lease);
    if (phase === 'continuing') machine.beginContinuation();
    machine.abort();
    expect(machine.current).toBe('idle');
    expect(machine.owns(lease)).toBe(false);
  }
});

it('completeOutcome emits response terminals and returns to idle', () => {
  const machine = new TurnStatusMachine();
  const lease = machine.beginTurn();
  expect(machine.completeOutcome({ kind: 'response', terminal: terminalResponse }, lease)).toEqual({
    kind: 'emit_terminal',
    terminal: terminalResponse,
  });
  expect(machine.current).toBe('idle');
});

it('completeOutcome emits approval terminals and enters awaiting approval', () => {
  const machine = new TurnStatusMachine();
  const lease = machine.beginTurn();
  expect(machine.completeOutcome({ kind: 'approval_required', terminal: terminalApproval }, lease)).toEqual({
    kind: 'emit_terminal',
    terminal: terminalApproval,
  });
  expect(machine.current).toBe('awaiting_approval');
});

it('stale and failed outcomes do not emit', () => {
  const staleMachine = new TurnStatusMachine();
  const staleLease = staleMachine.beginTurn();
  expect(staleMachine.completeOutcome({ kind: 'stale' }, staleLease)).toEqual({ kind: 'none' });
  expect(staleMachine.current).toBe('streaming');

  const failedMachine = new TurnStatusMachine();
  const failedLease = failedMachine.beginTurn();
  expect(failedMachine.completeOutcome({ kind: 'failed' }, failedLease)).toEqual({ kind: 'none' });
  expect(failedMachine.current).toBe('idle');
});

it('stale lease cannot request approval or complete a newer turn', () => {
  const machine = new TurnStatusMachine();
  const staleLease = machine.beginTurn();
  machine.abort();
  const currentLease = machine.beginTurn();

  machine.requestApproval(staleLease);
  machine.complete(staleLease);

  expect(machine.current).toBe('streaming');
  expect(machine.owns(currentLease)).toBe(true);
});

it('stale lease outcomes emit nothing and cannot mutate a newer turn', () => {
  const machine = new TurnStatusMachine();
  const staleLease = machine.beginTurn();
  machine.abort();
  const currentLease = machine.beginTurn();

  expect(machine.completeOutcome({ kind: 'response', terminal: terminalResponse }, staleLease)).toEqual({ kind: 'none' });
  expect(
    machine.completeContinuationOutcome({ kind: 'approval_required', terminal: terminalApproval }, staleLease),
  ).toEqual({ kind: 'none' });
  expect(machine.current).toBe('streaming');
  expect(machine.owns(currentLease)).toBe(true);
});
