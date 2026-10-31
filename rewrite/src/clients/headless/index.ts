/**
 * Headless client.
 *
 * `runDirectHeadless` is the M5 path: one prompt over `DirectConnection`, with
 * the old non-interactive plain/JSON output, approval and completion rules.
 * `renderTurn` remains for the current app/run engine-event path until the app
 * integration owner switches it to the direct connection.
 */
export { formatToolSummary, interactionLine, rejectionLine, toolStartLine } from './format.js';
export { decideHeadlessApproval, runDirectHeadless } from './direct.js';
export { renderTurn } from './render.js';
export type {
  DirectHeadlessOptions,
  DirectHeadlessOutcome,
  DirectHeadlessResult,
  HeadlessApprovalDecider,
  HeadlessDecision,
  HeadlessEvent,
  HeadlessIo,
  HeadlessOutput,
} from './types.js';
