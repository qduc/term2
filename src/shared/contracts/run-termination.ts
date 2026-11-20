/** Typed terminal causes that may be attached to a completed application run.

 * A cause is separate from provider success: a budget-contained response can
 * have a valid terminal model response while the logical worker is unfinished.
 */
export type RunTerminationCause =
  | 'budget_exhausted'
  /** An active durable goal's stop check stayed unresolved; control returned to the user. */
  | 'goal_check_unresolved'
  /** The completion gate could not authorize a durable goal's completion. */
  | 'completion_verification_blocked';

const RUN_TERMINATION_CAUSES: ReadonlySet<string> = new Set<RunTerminationCause>([
  'budget_exhausted',
  'goal_check_unresolved',
  'completion_verification_blocked',
]);

/**
 * Narrow a harness terminal cause. The harness reports `budget_exhausted` itself and otherwise echoes the
 * cause Term2's own normal-stop policy returned, so any other value cannot occur and is dropped.
 */
export function runTerminationCause(cause: string | undefined): RunTerminationCause | undefined {
  return cause !== undefined && RUN_TERMINATION_CAUSES.has(cause) ? (cause as RunTerminationCause) : undefined;
}
