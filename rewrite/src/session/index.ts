/**
 * session/ — one durable conversation: an append-only log and the state
 * replayed from it.
 *
 * `direct-store.ts` creates and opens sessions in the native conversations
 * directory and hands the host a `DirectSession` (`direct-session.ts`), the
 * live facade over one `Conversation` (`conversation.ts`). Only the
 * conversation writes facts. A submitted message is admitted to the log, then
 * `conversation-turn.ts` starts the engine turn and is the sole reader of its
 * events: it appends each accepted item, answers interactions, and records the
 * terminal outcome. `facts.ts` is the log's vocabulary, `log.ts` and
 * `direct-rolling-log.ts` write it, and `replay.ts` folds it back into state.
 *
 * When a tool needs approval, the turn stays parked in memory and the log holds
 * the pending interaction. A process that dies there reopens the turn as
 * interrupted; nothing resumes on its own.
 *
 * The host contracts below are what the host and app import.
 * Depends on: engine, model, tools, config.
 */

export type {
  DirectAdmission,
  DirectBinding,
  DirectDraft,
  DirectCancelTarget,
  DirectMessage,
  DirectOrigin,
  DirectSession,
  DirectSessionCapture,
  DirectSessionReplayCapture,
  DirectSessionState,
  DirectSessionStore,
  DirectSessionUpdate,
  DirectSubmission,
  DirectToolDisplay,
} from './facade-types.js';
