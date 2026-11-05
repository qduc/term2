/**
 * Compatibility error for legacy callers without a staged run budget. The loop
 * owns turn counting — the SDK-era `callModelInputFilter` hook is deliberately
 * not reintroduced.
 *
 * Lives outside the run loop so subagent helpers can recognize it without
 * loading the loop.
 */
export class MaxTurnsExceededError extends Error {
  readonly maxTurns: number;

  constructor(maxTurns: number) {
    super(`Max turns (${maxTurns}) exceeded`);
    this.name = 'MaxTurnsExceededError';
    this.maxTurns = maxTurns;
  }
}
