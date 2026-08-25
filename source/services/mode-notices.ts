import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical mode-change notices injected into the next user message when the
 * user toggles plan mode at runtime. Prefixing the next real turn avoids a
 * synthetic standalone history item while still making the mode change visible
 * to the model and persistent in the conversation transcript.
 *
 * The workflow body lives here, not in the instruction prefix, so a toggle
 * cannot change developer instructions on chained Responses-Lite HTTP turns.
 */
const PLAN_MODE_WORKFLOW = fs
  .readFileSync(path.join(import.meta.dirname, '../prompts/plan-mode-info.md'), 'utf8')
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

export const planModeNotice = (entering: boolean): string =>
  entering ? PLAN_MODE_ENTER_NOTICE : PLAN_MODE_EXIT_NOTICE;

export function primePlanModeNoticeIfActive(planMode: boolean, queue: (text: string) => void): void {
  if (planMode) queue(planModeNotice(true));
}
