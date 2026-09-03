import type { ISettingsService } from './service-interfaces.js';
import { resolveActiveProfile } from './profiles/active-profile.js';
import { resolveProfile } from './profiles/resolver.js';
import { ProfileResolutionError } from './profiles/types.js';
import type { ResolvedProfile } from './profiles/types.js';

/**
 * Canonical mode-change notices injected into the next user message when the
 * user toggles a runtime mode. Prefixing the next real turn avoids a
 * synthetic standalone history item while still making the mode change visible
 * to the model and persistent in the conversation transcript.
 *
 * The workflow body lives here, not in the instruction prefix, so a toggle
 * cannot change developer instructions on chained Responses-Lite HTTP turns.
 */
const NOTICE_PROFILE_IDS = new Set(['builtin:plan', 'builtin:mentor', 'builtin:orchestrator']);

const resolveNoticeProfile = (profile: ResolvedProfile | string): ResolvedProfile | null => {
  if (typeof profile !== 'string') return profile;
  if (!NOTICE_PROFILE_IDS.has(profile)) return null;
  return resolveProfile(profile);
};

const workflowText = (profile: ResolvedProfile): string | null => {
  const workflow = profile.instructions.workflow;
  return workflow?.kind === 'markdown' ? workflow.content : null;
};

/** Return the workflow notice associated with a resolved Profile. */
export function profileEnterNotice(profile: ResolvedProfile): string | null;
/** Compatibility overload for callers that still have a canonical Profile ID. */
export function profileEnterNotice(profileId: string): string | null;
export function profileEnterNotice(profile: ResolvedProfile | string): string | null {
  const resolved = resolveNoticeProfile(profile);
  if (!resolved) return null;
  const workflow = workflowText(resolved);
  if (!workflow) return null;

  if (resolved.identity.id === 'builtin:plan')
    return (
      '<system-notice>\n' +
      'Plan Mode is ON: the workspace is read-only. Do not create or modify files, run ' +
      'state-changing commands, or spawn write-capable subagents. Investigate with read-only ' +
      'tools and deliver a concrete, ordered implementation plan; tell the user to exit Plan ' +
      'Mode to execute it.\n\n' +
      workflow +
      '\n</system-notice>'
    );
  if (resolved.identity.id === 'builtin:mentor')
    return (
      '<system-notice>\n' +
      'Mentor Mode is ON. Work collaboratively with the configured mentor model and follow the mentor workflow below.\n\n' +
      workflow +
      '\n</system-notice>'
    );
  if (resolved.identity.id === 'builtin:orchestrator')
    return (
      '<system-notice>\n' +
      'Orchestrator Mode is ON. Follow the orchestrator workflow below while retaining end-to-end ownership of the user outcome.\n\n' +
      workflow +
      '\n</system-notice>'
    );
  return null;
}

/** Return the exit notice associated with a resolved Profile. */
export function profileExitNotice(profile: ResolvedProfile): string | null;
/** Compatibility overload for callers that still have a canonical Profile ID. */
export function profileExitNotice(profileId: string): string | null;
export function profileExitNotice(profile: ResolvedProfile | string): string | null {
  const resolved = resolveNoticeProfile(profile);
  if (!resolved) return null;
  if (resolved.identity.id === 'builtin:plan')
    return (
      '<system-notice>\n' +
      'Plan Mode is now ' +
      'OFF: the read-only restriction is lifted. You may again create and ' +
      'modify files, run state-changing commands, and spawn write-capable subagents to execute ' +
      'the plan.\n' +
      '</system-notice>'
    );
  if (resolved.identity.id === 'builtin:mentor')
    return (
      '<system-notice>\n' +
      'Mentor Mode is now OFF. Return to the normal workflow and do not treat the mentor-specific workflow as active.\n' +
      '</system-notice>'
    );
  if (resolved.identity.id === 'builtin:orchestrator')
    return (
      '<system-notice>\n' +
      'Orchestrator Mode is now OFF. Return to the normal workflow; you may work directly when appropriate instead of following orchestrator-only delegation policy.\n' +
      '</system-notice>'
    );
  return null;
}

// Keep the historical constants available to compatibility callers. Their
// content is produced through Profile resolution rather than a second prompt
// file-loading path in this module.
export const PLAN_MODE_ENTER_NOTICE = profileEnterNotice(resolveProfile('builtin:plan'))!;
export const PLAN_MODE_EXIT_NOTICE = profileExitNotice(resolveProfile('builtin:plan'))!;
export const MENTOR_MODE_ENTER_NOTICE = profileEnterNotice(resolveProfile('builtin:mentor'))!;
export const MENTOR_MODE_EXIT_NOTICE = profileExitNotice(resolveProfile('builtin:mentor'))!;
export const ORCHESTRATOR_MODE_ENTER_NOTICE = profileEnterNotice(resolveProfile('builtin:orchestrator'))!;
export const ORCHESTRATOR_MODE_EXIT_NOTICE = profileExitNotice(resolveProfile('builtin:orchestrator'))!;

/** Prime the active Profile's workflow once, without consulting legacy flags. */
export function primeActiveProfileNoticeIfActive(
  settingsService: ISettingsService,
  queue: (text: string) => void,
): void {
  try {
    const notice = profileEnterNotice(resolveActiveProfile(settingsService));
    if (notice) queue(notice);
  } catch (error) {
    // Startup priming should not make an otherwise recoverable settings state
    // unusable. Activation itself remains strict and reports this error.
    if (!(error instanceof ProfileResolutionError)) throw error;
  }
}
