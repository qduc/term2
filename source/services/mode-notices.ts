/**
 * Canonical mode-change notices injected into the conversation when the user
 * toggles plan mode at runtime. They are persisted into the conversation
 * history (append-only, at the tail) so the cached prefix only ever grows —
 * a transient one-shot notice would make consecutive requests diverge at the
 * tail and break the provider prompt cache.
 */
export const PLAN_MODE_ENTER_NOTICE =
  'Plan Mode is now ON: the workspace is read-only. Do not create or modify files, run ' +
  'state-changing commands, or spawn write-capable subagents. Investigate with read-only ' +
  'tools and deliver a concrete, ordered implementation plan; tell the user to exit Plan ' +
  'Mode to execute it.';

export const PLAN_MODE_EXIT_NOTICE =
  'Plan Mode is now OFF: the read-only restriction is lifted. You may again create and ' +
  'modify files, run state-changing commands, and spawn write-capable subagents to execute ' +
  'the plan.';

export const planModeNotice = (entering: boolean): string =>
  entering ? PLAN_MODE_ENTER_NOTICE : PLAN_MODE_EXIT_NOTICE;
