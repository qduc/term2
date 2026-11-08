/**
 * Profiles next does not offer or enter (owner decision, #149): legacy's plan, pair, mentor and orchestrator. The
 * consumer UI has no profile menu and explicit selections treat them as unknown. Saved settings and sessions
 * that name one fall back to Bare without rewriting their persisted history.
 */
const DROPPED = new Set(['plan', 'pair', 'mentor', 'orchestrator']);

/** True for a dropped profile, by short name (`plan`) or built-in id (`builtin:plan`). */
export function isDroppedProfile(id: string): boolean {
  return DROPPED.has(id.startsWith('builtin:') ? id.slice('builtin:'.length) : id);
}
