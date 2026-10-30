/**
 * The approval half of the removed SDK's RunContext, as an application-owned
 * typed ledger:
 *
 * - the record is keyed by tool name, not call id;
 * - `approved: true` / `rejected: true` are blanket decisions covering every
 *   call of that tool;
 * - `approved: string[]` / `rejected: string[]` record which calls a one-time
 *   decision was made for;
 * - a blanket approval outranks a blanket rejection ({@link ApprovalLedger.blanketDecision}).
 *
 * Only blanket decisions are ever consulted ({@link ApprovalLedger.blanketDecision}).
 * A one-time decision belongs to the plan entry it settled — its rejection
 * message becomes that entry's output — and the per-call entries here are a
 * record only: call ids repeat across responses and runs, so they can never
 * authorize, reject, or explain a later call.
 *
 * It does NOT carry the run's user context — that lives on
 * {@link ToolInvocationContext.context}. Splitting the two is the point: the
 * old RunContext conflated a ledger with a context bag.
 */
export class ApprovalLedger {
    #approvals = {};
    approveTool(item, options = {}) {
        const current = this.#approvals[item.toolName] ?? { approved: [], rejected: [] };
        // Recording a one-time decision must not erase a blanket one for the tool.
        current.approved =
            options.alwaysApprove || current.approved === true
                ? true
                : [...(Array.isArray(current.approved) ? current.approved : []), item.callId];
        this.#approvals[item.toolName] = current;
    }
    /**
     * `message` is kept only for a blanket rejection, where it explains every
     * later call. A one-time rejection's message is the settled plan entry's
     * output, not ledger state.
     */
    rejectTool(item, options = {}) {
        const current = this.#approvals[item.toolName] ?? { approved: [], rejected: [] };
        // Recording a one-time decision must not erase a blanket one for the tool.
        current.rejected =
            options.alwaysReject || current.rejected === true
                ? true
                : [...(Array.isArray(current.rejected) ? current.rejected : []), item.callId];
        if (options.alwaysReject && options.message)
            current.stickyRejectMessage = options.message;
        this.#approvals[item.toolName] = current;
    }
    /**
     * The tool's blanket decision, ignoring per-call entries. Call ids are not
     * unique across responses (the chat adapter's `call_${index}` fallback, or a
     * provider that repeats its own ids), so a per-call entry cannot identify a
     * new call: it only records the call it was made for.
     */
    blanketDecision(toolName) {
        const record = this.#approvals[toolName];
        if (record?.approved === true)
            return true;
        if (record?.rejected === true)
            return false;
        return undefined;
    }
    /** The message a blanket rejection of the tool gives every call it rejects. */
    blanketRejectionMessage(toolName) {
        const record = this.#approvals[toolName];
        return record?.rejected === true ? record.stickyRejectMessage : undefined;
    }
    /**
     * Plain copy of the ledger for parent→child replay (replaces the old
     * `toJSON()` structural probe in `readParentApprovals`). Same record shape
     * `replayApprovals` consumes, so a snapshot replays into a fresh ledger.
     */
    snapshot() {
        return structuredClone(this.#approvals);
    }
}
//# sourceMappingURL=tool-invocation-context.js.map