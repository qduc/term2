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
