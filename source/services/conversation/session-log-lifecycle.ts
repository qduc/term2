import type { ConversationLogWriter } from '../logging/conversation-log-writer.js';
import type { DurableGoal, SessionInitEvent } from '../logging/conversation-log-events.js';

/** Rotate persistence and durably carry session-owned state before the caller commits its lifecycle transition. */
export function rotateSessionLog(
  writer: ConversationLogWriter,
  newSessionId: string,
  meta: Omit<SessionInitEvent, 'type'>,
  rolloverGoal?: DurableGoal,
): void {
  writer.append({ type: 'session_cleared' });
  writer.rotate(newSessionId, meta);
  if (meta.rolloverFrom && rolloverGoal) {
    writer.append({ type: 'goal_changed', version: 1, goal: rolloverGoal });
  }
}
