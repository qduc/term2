import { PARENT_TOOL_OWNER } from './tool-owner.js';
export class ApprovalState {
    pending = null;
    aborted = null;
    getPending() {
        return this.pending;
    }
    setPending(context) {
        context.owner ??= PARENT_TOOL_OWNER;
        this.pending = context;
    }
    clearPending() {
        this.pending = null;
    }
    abortPending() {
        if (!this.pending) {
            return false;
        }
        this.aborted = {
            state: this.pending.state,
            interruption: this.pending.interruption,
            interruptions: this.pending.interruptions,
            decisionsByCallId: this.pending.decisionsByCallId,
            promptedCallId: this.pending.promptedCallId,
            owner: this.pending.owner,
            token: this.pending.token,
            inputMode: this.pending.inputMode,
        };
        this.pending = null;
        return true;
    }
    consumeAborted() {
        const aborted = this.aborted;
        this.aborted = null;
        return aborted;
    }
}
//# sourceMappingURL=approval-state.js.map