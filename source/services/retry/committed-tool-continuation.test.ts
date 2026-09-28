import { it, expect } from 'vitest';
import {
  isSettledCommittedToolContinuation,
  admitsProviderStateRejectionRecovery,
  skipsAutomaticReplayClaim,
} from './committed-tool-continuation.js';

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

it('admits provider-state rejection recovery once every live-turn tool completed locally, regardless of projection', () => {
  expect(admitsProviderStateRejectionRecovery(undefined)).toBe(false);
  expect(admitsProviderStateRejectionRecovery({ ...settled, completedToolCount: 0 })).toBe(false);
  expect(admitsProviderStateRejectionRecovery({ ...settled, allToolsCompleted: false })).toBe(false);
  // Durable pairs kept out of the projected request by a compaction boundary
  // must not refuse recovery: the provider rejected the chain before accepting
  // it, so recovery rebuilds full history without replaying a completed tool.
  expect(admitsProviderStateRejectionRecovery({ ...settled, completedPairsPresentInHistory: false })).toBe(true);
  expect(admitsProviderStateRejectionRecovery(settled)).toBe(true);
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
