import fs from 'node:fs';
import path from 'node:path';
import type { ISettingsService } from './service-interfaces.js';
import { resolveActiveProfile } from './profiles/active-profile.js';
import { ProfileResolutionError } from './profiles/types.js';

/**
 * Canonical mode-change notices injected into the next user message when the
 * user toggles a runtime mode. Prefixing the next real turn avoids a
 * synthetic standalone history item while still making the mode change visible
 * to the model and persistent in the conversation transcript.
 *
 * The workflow body lives here, not in the instruction prefix, so a toggle
 * cannot change developer instructions on chained Responses-Lite HTTP turns.
 */
const PLAN_MODE_WORKFLOW = fs
  .readFileSync(path.join(import.meta.dirname, '../prompts/plan-mode-info.md'), 'utf8')
  .trim();
const MENTOR_MODE_WORKFLOW = fs
  .readFileSync(path.join(import.meta.dirname, '../prompts/mentor-addon.md'), 'utf8')
  .trim();
const ORCHESTRATOR_MODE_WORKFLOW = fs
  .readFileSync(path.join(import.meta.dirname, '../prompts/orchestrator.md'), 'utf8')
  .trim();

export const PLAN_MODE_ENTER_NOTICE =
  '<system-notice>\n' +
  'Plan Mode is ON: the workspace is read-only. Do not create or modify files, run ' +
  'state-changing commands, or spawn write-capable subagents. Investigate with read-only ' +
  'tools and deliver a concrete, ordered implementation plan; tell the user to exit Plan ' +
  'Mode to execute it.\n\n' +
  PLAN_MODE_WORKFLOW +
  '\n</system-notice>';

export const PLAN_MODE_EXIT_NOTICE =
  '<system-notice>\n' +
  'Plan Mode is now ' +
  'OFF: the read-only restriction is lifted. You may again create and ' +
  'modify files, run state-changing commands, and spawn write-capable subagents to execute ' +
  'the plan.\n' +
  '</system-notice>';

export const MENTOR_MODE_ENTER_NOTICE =
  '<system-notice>\n' +
  'Mentor Mode is ON. Work collaboratively with the configured mentor model and follow the mentor workflow below.\n\n' +
  MENTOR_MODE_WORKFLOW +
  '\n</system-notice>';

export const MENTOR_MODE_EXIT_NOTICE =
  '<system-notice>\n' +
  'Mentor Mode is now OFF. Return to the normal workflow and do not treat the mentor-specific workflow as active.\n' +
  '</system-notice>';

export const ORCHESTRATOR_MODE_ENTER_NOTICE =
  '<system-notice>\n' +
  'Orchestrator Mode is ON. Follow the orchestrator workflow below while retaining end-to-end ownership of the user outcome.\n\n' +
  ORCHESTRATOR_MODE_WORKFLOW +
  '\n</system-notice>';

export const ORCHESTRATOR_MODE_EXIT_NOTICE =
  '<system-notice>\n' +
  'Orchestrator Mode is now OFF. Return to the normal workflow; you may work directly when appropriate instead of following orchestrator-only delegation policy.\n' +
  '</system-notice>';

/** Return the workflow notice associated with a canonical Profile identity. */
export function profileEnterNotice(profileId: string): string | null {
  if (profileId === 'builtin:plan') return PLAN_MODE_ENTER_NOTICE;
  if (profileId === 'builtin:mentor') return MENTOR_MODE_ENTER_NOTICE;
  if (profileId === 'builtin:orchestrator') return ORCHESTRATOR_MODE_ENTER_NOTICE;
  return null;
}

/** Return the exit notice associated with a canonical Profile identity. */
export function profileExitNotice(profileId: string): string | null {
  if (profileId === 'builtin:plan') return PLAN_MODE_EXIT_NOTICE;
  if (profileId === 'builtin:mentor') return MENTOR_MODE_EXIT_NOTICE;
  if (profileId === 'builtin:orchestrator') return ORCHESTRATOR_MODE_EXIT_NOTICE;
  return null;
}

/** Prime the active Profile's workflow once, without consulting legacy flags. */
export function primeActiveProfileNoticeIfActive(
  settingsService: ISettingsService,
  queue: (text: string) => void,
): void {
  try {
    const notice = profileEnterNotice(resolveActiveProfile(settingsService).identity.id);
    if (notice) queue(notice);
  } catch (error) {
    // Startup priming should not make an otherwise recoverable settings state
    // unusable. Activation itself remains strict and reports this error.
    if (!(error instanceof ProfileResolutionError)) throw error;
  }
}
