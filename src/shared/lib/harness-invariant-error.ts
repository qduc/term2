/**
 * Raised by a tool when its own preconditions are violated — a bug in this
 * application, not something the model did wrong.
 *
 * Every other tool failure is reported back to the model as tool output so it
 * can correct its arguments or route around the problem. That default is wrong
 * for invariant violations: the model has no useful next action, and quietly
 * handing it an internal error invites a pointless retry. Throwing this type
 * instead fails the run loudly, which is what a harness bug deserves.
 *
 * The distinction is only knowable where the error is raised. The run loop
 * catches an `Error` and cannot tell a bad search path from a broken
 * precondition, so tools have to say which one it is.
 */
export class HarnessInvariantError extends Error {
  readonly code = 'harness_invariant';

  constructor(message: string) {
    super(message);
    this.name = 'HarnessInvariantError';
  }
}

export function isHarnessInvariantError(error: unknown): error is HarnessInvariantError {
  return error instanceof HarnessInvariantError || (error as { code?: unknown } | null)?.code === 'harness_invariant';
}

/** Cancellation is the run ending on purpose; it must never become tool output. */
export function isCancellationError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}
