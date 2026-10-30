/** Rotate persistence and durably carry session-owned state before the caller commits its lifecycle transition. */
export function rotateSessionLog(writer, newSessionId, meta, rolloverGoal) {
    writer.append({ type: 'session_cleared' });
    const initialEvents = meta.rolloverFrom && rolloverGoal ? [{ type: 'goal_changed', version: 1, goal: rolloverGoal }] : [];
    writer.rotate(newSessionId, meta, initialEvents);
}
//# sourceMappingURL=session-log-lifecycle.js.map