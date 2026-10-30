/**
 * Call id attached to a replayed blanket decision. A blanket decision belongs to the tool
 * rather than to any one call, but `approveTool`/`rejectTool` only accept a call. This
 * sentinel keeps the synthetic call from colliding with a real one.
 */
const BLANKET_DECISION_CALL_ID = '__approval_replay_blanket_decision__';
function buildApprovalItem(toolName, callId, agent) {
    return {
        rawItem: { type: 'function_call', callId, name: toolName, arguments: '{}', status: 'completed' },
        agent,
        toolName,
        // Top-level callId so typed ledgers (ApprovalLedger) can consume the item
        // without probing rawItem.
        callId,
    };
}
/**
 * Seeds `target` with the blanket decisions already taken elsewhere — in practice, replaying a
 * parent run's "always allow" / "always reject" decisions into a freshly created nested
 * subagent ledger so that a tool the user approved for every call does not prompt a second
 * time inside the subagent.
 *
 * One-time (per-call) decisions are deliberately NOT replayed. They belong to the parent's
 * call; the nested run's provider numbers its own calls, so a matching id there is a
 * different call that must be presented to the user again.
 *
 * Uses only the public `approveTool` / `rejectTool` surface. A record holding both blanket
 * decisions replays both, and the target resolves it as the source did: a blanket approval
 * outranks a blanket rejection.
 */
export function replayApprovals(target, approvals, agent) {
    if (!approvals)
        return;
    for (const [toolName, record] of Object.entries(approvals)) {
        if (!record)
            continue;
        if (record.rejected === true) {
            target.rejectTool(buildApprovalItem(toolName, BLANKET_DECISION_CALL_ID, agent), {
                alwaysReject: true,
                message: record.stickyRejectMessage,
            });
        }
        if (record.approved === true) {
            target.approveTool(buildApprovalItem(toolName, BLANKET_DECISION_CALL_ID, agent), {
                alwaysApprove: true,
            });
        }
    }
}
//# sourceMappingURL=approval-replay.js.map