import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

it('fromInitialOutcome maps response correctly', () => {
  const outcome: InitialTurnOutcome = { kind: 'response', terminal: terminalResponse };
  const result = fromInitialOutcome(outcome);

  expect(result.kind).toBe('response');
  if (result.kind === 'response') {
    expect(result.terminal).toBe(terminalResponse);
  }
});

it('fromInitialOutcome maps approval_required correctly', () => {
  const outcome: InitialTurnOutcome = { kind: 'approval_required', terminal: terminalApproval };
  const result = fromInitialOutcome(outcome);

  expect(result.kind).toBe('approval_required');
  if (result.kind === 'approval_required') {
    expect(result.terminal).toBe(terminalApproval);
  }
});

it('fromInitialOutcome maps failed correctly', () => {
  const outcome: InitialTurnOutcome = { kind: 'failed' };
  const result = fromInitialOutcome(outcome);

  expect(result.kind).toBe('failed');
});

it('fromInitialOutcome maps stale correctly', () => {
  const outcome: InitialTurnOutcome = { kind: 'stale' };
  const result = fromInitialOutcome(outcome);

  expect(result.kind).toBe('stale');
});

// ── fromDriveResult ────────────────────────────────────────────

it('fromDriveResult maps response correctly', () => {
  const driveResult: ContinuationDriveResult = { kind: 'response', terminal: terminalResponse };
  const result = fromDriveResult(driveResult);

  expect(result.kind).toBe('response');
  if (result.kind === 'response') {
    expect(result.terminal).toBe(terminalResponse);
  }
});

it('fromDriveResult maps approval_required correctly', () => {
  const driveResult: ContinuationDriveResult = { kind: 'approval_required', terminal: terminalApproval };
  const result = fromDriveResult(driveResult);

  expect(result.kind).toBe('approval_required');
  if (result.kind === 'approval_required') {
    expect(result.terminal).toBe(terminalApproval);
  }
});

it('fromDriveResult maps stale correctly', () => {
  const driveResult: ContinuationDriveResult = { kind: 'stale' };
  const result = fromDriveResult(driveResult);

  expect(result.kind).toBe('stale');
});

it('fromDriveResult maps fresh_start_required with retryCounts only', () => {
  const driveResult: ContinuationDriveResult = {
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
  };
  const result = fromDriveResult(driveResult);

  expect(result.kind).toBe('fresh_start_required');
  if (result.kind === 'fresh_start_required') {
    expect(result.retryCounts).toBe(defaultRetryCounts);
    expect(result.delayMs).toBe(undefined);
    expect(result.useStandardServiceTier).toBe(undefined);
  }
});

it('fromDriveResult maps fresh_start_required with retryCounts + delayMs + useStandardServiceTier', () => {
  const driveResult: ContinuationDriveResult = {
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
    delayMs: 500,
    useStandardServiceTier: true,
  };
  const result = fromDriveResult(driveResult);

  expect(result.kind).toBe('fresh_start_required');
  if (result.kind === 'fresh_start_required') {
    expect(result.retryCounts).toBe(defaultRetryCounts);
    expect(result.delayMs).toBe(500);
    expect(result.useStandardServiceTier).toBe(true);
  }
});
