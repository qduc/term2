/**
 * Internal, import-safe core entry.
 *
 * This is intentionally a small in-place boundary around the existing
 * SessionRuntime composition. It is not a public package or web protocol.
 */
export { createSessionRuntime } from './session-runtime.js';
export type {
  BackgroundSubagentApprovalChannel,
  CreateConversationSessionOptions,
  SessionApprovalQuery,
  SessionLogs,
  SessionRuntime,
} from './session-runtime.js';
