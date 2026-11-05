/**
 * Profiles next does not offer or enter (owner decision, #149): legacy's plan, pair, mentor and orchestrator. The
 * /profile menu leaves them out and `/profile <name>` treats one as unknown. A setting that already names one still
 * runs it for now: the settings-batch and tools-batch goldens were recorded that way (see application-runtime).
 */
const DROPPED = new Set(['plan', 'pair', 'mentor', 'orchestrator']);

/** True for a dropped profile, by short name (`plan`) or built-in id (`builtin:plan`). */
export function isDroppedProfile(id: string): boolean {
  return DROPPED.has(id.startsWith('builtin:') ? id.slice('builtin:'.length) : id);
}
