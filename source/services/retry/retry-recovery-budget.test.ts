import { it, expect } from 'vitest';
import {
  RetryRecoveryBudget,
  RetryRecoveryBudgetExhaustedError,
  isRetryRecoveryBudgetExhaustedError,
} from './retry-recovery-budget.js';

it('claims up to maxPhysicalAttempts and then refuses further claims', () => {
  const budget = new RetryRecoveryBudget({ maxPhysicalAttempts: 3 });

  expect(budget.claimPhysicalAttempt()).toBe(true);
  expect(budget.claimPhysicalAttempt()).toBe(true);
  expect(budget.claimPhysicalAttempt()).toBe(true);
  expect(budget.claimPhysicalAttempt()).toBe(false);
  expect(budget.physicalAttempts).toBe(3);
});

it('claims up to maxAutomaticReplays and then refuses further claims', () => {
  const budget = new RetryRecoveryBudget({ maxAutomaticReplays: 1 });

  expect(budget.claimAutomaticReplay()).toBe(true);
  expect(budget.claimAutomaticReplay()).toBe(false);
  expect(budget.automaticReplays).toBe(1);
});

it('does not start the recovery clock until the first retryable failure is observed', () => {
  let now = 1000;
  const budget = new RetryRecoveryBudget({ now: () => now });

  expect(budget.startedAt).toBeUndefined();
  expect(budget.elapsedMs).toBe(0);
  expect(budget.deadlineExceeded).toBe(false);

  now = 5000;
  budget.noteRetryableFailure();
  expect(budget.startedAt).toBe(5000);

  now = 7500;
  expect(budget.elapsedMs).toBe(2500);
});

it('refuses further claims once the deadline elapses, even with attempts remaining', () => {
  let now = 0;
  const budget = new RetryRecoveryBudget({ now: () => now, maxRecoveryTimeMs: 90_000, maxPhysicalAttempts: 3 });

  budget.noteRetryableFailure();
  now = 90_001;

  expect(budget.deadlineExceeded).toBe(true);
  expect(budget.claimPhysicalAttempt()).toBe(false);
  expect(budget.claimAutomaticReplay()).toBe(false);
});

it('a second noteRetryableFailure does not reset an already-running clock', () => {
  let now = 0;
  const budget = new RetryRecoveryBudget({ now: () => now });

  budget.noteRetryableFailure();
  now = 1000;
  budget.noteRetryableFailure();

  expect(budget.startedAt).toBe(0);
  expect(budget.elapsedMs).toBe(1000);
});

it('RetryRecoveryBudgetExhaustedError carries the triggering error as cause', () => {
  const trigger = new Error('upstream 503');
  const error = new RetryRecoveryBudgetExhaustedError(trigger);

  expect(error.cause).toBe(trigger);
  expect(isRetryRecoveryBudgetExhaustedError(error)).toBe(true);
  expect(isRetryRecoveryBudgetExhaustedError(trigger)).toBe(false);
  expect(isRetryRecoveryBudgetExhaustedError(new Error('unrelated'))).toBe(false);
});
