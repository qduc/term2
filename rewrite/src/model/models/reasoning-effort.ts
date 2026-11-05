/**
 * The reasoning-effort vocabulary and the ":<effort>" suffix rule shared by
 * --model flag parsing and nickname-target parsing. Kept in its own module so
 * model-nicknames can reuse the exact same suffix semantics without importing
 * model-resolution (which imports model-nicknames for the resolution fast
 * path).
 */
export const VALID_REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ModelSettingsReasoningEffort = (typeof VALID_REASONING_EFFORTS)[number];

/**
 * Splits a trailing ":<effort>" suffix off a raw model-flag string or
 * nickname-target string. Only a recognized effort is stripped; any other
 * colon suffix (e.g. ":batch") stays part of the id, matching the
 * fail-open behavior of --model parsing.
 */
export function stripReasoningEffortSuffix(trimmed: string): {
  value: string;
  reasoningEffort?: ModelSettingsReasoningEffort;
} {
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx !== -1) {
    const potentialEffort = trimmed.slice(colonIdx + 1).toLowerCase();
    if ((VALID_REASONING_EFFORTS as readonly string[]).includes(potentialEffort)) {
      return {
        value: trimmed.slice(0, colonIdx).trim(),
        reasoningEffort: potentialEffort as ModelSettingsReasoningEffort,
      };
    }
  }
  return { value: trimmed, reasoningEffort: undefined };
}
