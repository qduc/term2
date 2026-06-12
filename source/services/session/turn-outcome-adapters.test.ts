import test from 'ava';
import { fromInitialOutcome, fromDriveResult } from './turn-outcome-adapters.js';
import type { InitialTurnOutcome } from './initial-turn-runner.js';
import type { ContinuationDriveResult } from './continuation-driver.js';
import type { ConversationTerminal, FinalTerminal, ApprovalRequiredTerminal } from '../../contracts/conversation.js';
import type { RetryCounts } from '../retry/retry-contracts.js';

// ── Helpers ────────────────────────────────────────────────────

const terminalResponse: ConversationTerminal = {
  type: 'response',
  commandMessages: [],
  finalText: 'hello',
} satisfies FinalTerminal;

const terminalApproval: ConversationTerminal = {
  type: 'approval_required',
  approval: {
    agentName: 'test',
    toolName: 'shell',
    argumentsText: 'ls',
    rawInterruption: {},
  },
} satisfies ApprovalRequiredTerminal;

const defaultRetryCounts: RetryCounts = {
  transientRetryCount: 1,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

// ── fromInitialOutcome ─────────────────────────────────────────

test('fromInitialOutcome maps response correctly', (t) => {
  const outcome: InitialTurnOutcome = { kind: 'response', terminal: terminalResponse };
  const result = fromInitialOutcome(outcome);

  t.is(result.kind, 'response');
  if (result.kind === 'response') {
    t.is(result.terminal, terminalResponse);
  }
});

test('fromInitialOutcome maps approval_required correctly', (t) => {
  const outcome: InitialTurnOutcome = { kind: 'approval_required', terminal: terminalApproval };
  const result = fromInitialOutcome(outcome);

  t.is(result.kind, 'approval_required');
  if (result.kind === 'approval_required') {
    t.is(result.terminal, terminalApproval);
  }
});

test('fromInitialOutcome maps failed correctly', (t) => {
  const outcome: InitialTurnOutcome = { kind: 'failed' };
  const result = fromInitialOutcome(outcome);

  t.is(result.kind, 'failed');
});

test('fromInitialOutcome maps stale correctly', (t) => {
  const outcome: InitialTurnOutcome = { kind: 'stale' };
  const result = fromInitialOutcome(outcome);

  t.is(result.kind, 'stale');
});

// ── fromDriveResult ────────────────────────────────────────────

test('fromDriveResult maps response correctly', (t) => {
  const driveResult: ContinuationDriveResult = { kind: 'response', terminal: terminalResponse };
  const result = fromDriveResult(driveResult);

  t.is(result.kind, 'response');
  if (result.kind === 'response') {
    t.is(result.terminal, terminalResponse);
  }
});

test('fromDriveResult maps approval_required correctly', (t) => {
  const driveResult: ContinuationDriveResult = { kind: 'approval_required', terminal: terminalApproval };
  const result = fromDriveResult(driveResult);

  t.is(result.kind, 'approval_required');
  if (result.kind === 'approval_required') {
    t.is(result.terminal, terminalApproval);
  }
});

test('fromDriveResult maps stale correctly', (t) => {
  const driveResult: ContinuationDriveResult = { kind: 'stale' };
  const result = fromDriveResult(driveResult);

  t.is(result.kind, 'stale');
});

test('fromDriveResult maps fresh_start_required with retryCounts only', (t) => {
  const driveResult: ContinuationDriveResult = {
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
  };
  const result = fromDriveResult(driveResult);

  t.is(result.kind, 'fresh_start_required');
  if (result.kind === 'fresh_start_required') {
    t.is(result.retryCounts, defaultRetryCounts);
    t.is(result.delayMs, undefined);
    t.is(result.useStandardServiceTier, undefined);
  }
});

test('fromDriveResult maps fresh_start_required with retryCounts + delayMs + useStandardServiceTier', (t) => {
  const driveResult: ContinuationDriveResult = {
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
    delayMs: 500,
    useStandardServiceTier: true,
  };
  const result = fromDriveResult(driveResult);

  t.is(result.kind, 'fresh_start_required');
  if (result.kind === 'fresh_start_required') {
    t.is(result.retryCounts, defaultRetryCounts);
    t.is(result.delayMs, 500);
    t.is(result.useStandardServiceTier, true);
  }
});
