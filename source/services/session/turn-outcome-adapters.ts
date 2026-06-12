import type { InitialTurnOutcome } from './initial-turn-runner.js';
import type { ContinuationDriveResult } from './continuation-driver.js';
import type { TurnOutcome } from './turn-transition.js';

// ── Adapters ───────────────────────────────────────────────────

/**
 * Convert an InitialTurnOutcome (from initial-turn-runner.ts) to the
 * canonical TurnOutcome type used by the transition engine.
 *
 * The mapping is nearly 1:1 — both types share the same field names
 * for `response` and `approval_required`, and the `failed` / `stale`
 * variants translate directly.
 */
export function fromInitialOutcome(outcome: InitialTurnOutcome): TurnOutcome {
  switch (outcome.kind) {
    case 'response':
      return { kind: 'response', terminal: outcome.terminal };

    case 'approval_required':
      return { kind: 'approval_required', terminal: outcome.terminal };

    case 'failed':
      return { kind: 'failed' };

    case 'stale':
      return { kind: 'stale' };

    // These intermediate outcomes are handled by TurnCoordinator before reaching
    // the transition core; map to stale as a safe fallback.
    case 'abort_resolution_required':
    case 'auto_approval_required':
      return { kind: 'stale' };
  }
}

/**
 * Convert a ContinuationDriveResult (from continuation-driver.ts) to the
 * canonical TurnOutcome type.
 *
 * Field names now match directly (`terminal` in both), so `response`,
 * `approval_required`, and `stale` pass through unchanged.
 * `fresh_start_required` spreads `RecoveryInstructions` fields
 * (`delayMs`, `useStandardServiceTier`) alongside `retryCounts`.
 */
export function fromDriveResult(result: ContinuationDriveResult): TurnOutcome {
  switch (result.kind) {
    case 'response':
    case 'approval_required':
    case 'stale':
      return result;

    case 'fresh_start_required':
      return {
        kind: 'fresh_start_required',
        retryCounts: result.retryCounts,
        ...(result.delayMs !== undefined ? { delayMs: result.delayMs } : {}),
        ...(result.useStandardServiceTier ? { useStandardServiceTier: true } : {}),
      };
  }
}
