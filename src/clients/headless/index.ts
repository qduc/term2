/**
 * Headless client: `runDirectHeadless` sends one prompt over `DirectConnection`,
 * with the old non-interactive plain/JSON output, approval and completion rules.
 */
export { formatToolSummary, interactionLine, rejectionLine, toolStartLine } from './format.js';
export { decideHeadlessApproval, runDirectHeadless } from './direct.js';
export type {
  DirectHeadlessOptions,
  DirectHeadlessOutcome,
  DirectHeadlessResult,
  HeadlessApprovalDecider,
  HeadlessDecision,
  HeadlessIo,
  HeadlessOutput,
} from './types.js';
