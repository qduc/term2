import { it, expect } from 'vitest';
import { isSettledCommittedToolContinuation, skipsAutomaticReplayClaim } from './committed-tool-continuation.js';

const settled = {
  completedToolCount: 1,
  allToolsCompleted: true,
  completedPairsPresentInHistory: true,
};

it('admits continuation only when completed tools exist, all are completed, and pairs are in history', () => {
  expect(isSettledCommittedToolContinuation(undefined)).toBe(false);
  expect(isSettledCommittedToolContinuation({ ...settled, completedToolCount: 0 })).toBe(false);
  expect(isSettledCommittedToolContinuation({ ...settled, allToolsCompleted: false })).toBe(false);
  expect(isSettledCommittedToolContinuation({ ...settled, completedPairsPresentInHistory: false })).toBe(false);
  expect(isSettledCommittedToolContinuation(settled)).toBe(true);
});

it('skips the automatic-replay claim for either chain-recovery cause when tools are settled', () => {
  expect(
    skipsAutomaticReplayClaim(
      { kind: 'chain_recovery', attempt: 1, delayMs: 5, cause: 'connection_interrupted' },
      settled,
    ),
  ).toBe(true);
  expect(
    skipsAutomaticReplayClaim(
      { kind: 'chain_recovery', attempt: 1, delayMs: 5, cause: 'provider_state_rejected' },
      settled,
    ),
  ).toBe(true);
  expect(skipsAutomaticReplayClaim({ kind: 'transient', attempt: 1, delayMs: 5 }, settled)).toBe(false);
  expect(
    skipsAutomaticReplayClaim(
      { kind: 'chain_recovery', attempt: 1, delayMs: 5, cause: 'connection_interrupted' },
      undefined,
    ),
  ).toBe(false);
});
