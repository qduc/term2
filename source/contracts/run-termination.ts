/** Typed terminal causes that may be attached to a completed application run.

 * A cause is separate from provider success: a budget-contained response can
 * have a valid terminal model response while the logical worker is unfinished.
 */
export type RunTerminationCause = 'budget_exhausted';
