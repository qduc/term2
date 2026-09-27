import type { ConversationLogWriter } from '../logging/conversation-log-writer.js';
import type { DurableGoal, LogEvent, SessionInitEvent } from '../logging/conversation-log-events.js';

/** Rotate persistence and durably carry session-owned state before the caller commits its lifecycle transition. */
export function rotateSessionLog(
  writer: ConversationLogWriter,
  newSessionId: string,
  meta: Omit<SessionInitEvent, 'type'>,
  rolloverGoal?: DurableGoal,
): void {
  writer.append({ type: 'session_cleared' });
  const initialEvents: LogEvent[] =
    meta.rolloverFrom && rolloverGoal ? [{ type: 'goal_changed', version: 1, goal: rolloverGoal }] : [];
  writer.rotate(newSessionId, meta, initialEvents);
}
