/**
 * Profiles next does not offer or enter (owner decision, #149): legacy's plan, pair, mentor and orchestrator. A
 * setting, a resumed session or `--profile` that names one runs Bare instead; `/profile` treats one as unknown.
 */
const DROPPED = new Set(['plan', 'pair', 'mentor', 'orchestrator']);

/** True for a dropped profile, by short name (`plan`) or built-in id (`builtin:plan`). */
export function isDroppedProfile(id: string): boolean {
  return DROPPED.has(id.startsWith('builtin:') ? id.slice('builtin:'.length) : id);
}

/** The profile a session runs: a dropped one falls back to `bare` (the caller's built-in Bare id). */
export function runnableProfile(id: string, bare: string): string {
  return isDroppedProfile(id) ? bare : id;
}
