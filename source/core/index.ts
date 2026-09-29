/**
 * Narrow, import-safe core entry.
 *
 * This is intentionally a small in-place boundary around the existing
 * SessionRuntime composition. It is not a public package or web protocol.
 */
export type {
  InteractionDecision,
  InteractionResult,
  Prepared,
  QueuedTurnStart,
  Rejected,
  SessionEvent,
  SessionHandle,
  SessionSnapshot,
} from './session-runtime.js';
