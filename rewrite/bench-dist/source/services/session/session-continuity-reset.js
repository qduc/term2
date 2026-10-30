import { getMethod } from '../interruption-info.js';
export class SessionContinuityReset {
    #providerContinuity;
    #approvalFlow;
    #toolTracker;
    #shellAutoApproval;
    #inputPlanner;
    #turnAccumulator;
    #agentClient;
    constructor(deps) {
        this.#providerContinuity = deps.providerContinuity;
        this.#approvalFlow = deps.approvalFlow;
        this.#toolTracker = deps.toolTracker;
        this.#shellAutoApproval = deps.shellAutoApproval;
        this.#inputPlanner = deps.inputPlanner;
        this.#turnAccumulator = deps.turnAccumulator;
        this.#agentClient = deps.agentClient;
    }
    reset({ clearConversations = true, rollover = false, } = {}) {
        this.#providerContinuity.clear();
        this.#approvalFlow.clearPending();
        this.#approvalFlow.consumeAborted();
        this.#toolTracker.clearArguments();
        this.#toolTracker.clearEmittedToolStarted();
        this.#shellAutoApproval.clearCache();
        this.#inputPlanner.reset();
        this.#turnAccumulator.resetPersistedTurnState();
        if (rollover) {
            this.#agentClient.rolloverRootContext?.();
        }
        else if (clearConversations) {
            const clearConversationsFn = getMethod(this.#agentClient, 'clearConversations');
            clearConversationsFn?.call(this.#agentClient);
        }
    }
}
//# sourceMappingURL=session-continuity-reset.js.map