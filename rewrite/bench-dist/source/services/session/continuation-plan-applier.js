import { getCallIdFromObject } from '../interruption-info.js';
import { isRunBudgetInteraction } from '../agent-runtime/run-budget.js';
export class ContinuationPlanApplier {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    prepareInit(init) {
        this.deps.record.beginDecisionResolution(init.kind === 'abort_resolution' ? 'abortResolution' : 'continueRunStream');
        if (init.kind === 'approval_decision') {
            const plan = this.deps.approvalFlow.prepareContinuation(init.answer, init.rejectionReason);
            if (!plan) {
                throw new Error('No pending approval for continuation');
            }
            // Budget evidence uses the continuation transport but is not a tool
            // approval. Tell the retained run whether to continue or settle; do not
            // manufacture a tool_started event or run normal approval policy.
            if (isRunBudgetInteraction(plan.pendingApprovalContext.interruption)) {
                if (init.answer === 'y')
                    plan.pendingApprovalContext.state.approve?.(plan.pendingApprovalContext.interruption);
                else
                    plan.pendingApprovalContext.state.reject?.(plan.pendingApprovalContext.interruption);
                return {
                    toolStartedEvent: undefined,
                    source: 'continueRunStream',
                    inputMode: plan.pendingApprovalContext.inputMode,
                };
            }
            if (init.answer !== 'y') {
                const callId = getCallIdFromObject(plan.pendingApprovalContext.interruption);
                const output = init.rejectionReason
                    ? `Tool execution was not approved. User's reason: ${init.rejectionReason}`
                    : 'Tool execution was not approved.';
                this.deps.record.recordAbortedApproval(output, output, callId);
            }
            return {
                toolStartedEvent: plan.toolStartedEvent,
                source: 'continueRunStream',
                inputMode: plan.pendingApprovalContext.inputMode,
            };
        }
        const { abortedContext } = init;
        this.deps.approvalFlow.prepareAbortResolution(abortedContext, init.userText);
        return {
            toolStartedEvent: undefined,
            source: 'abortResolution',
            inputMode: abortedContext.inputMode,
        };
    }
    async *applyInitialSetup(prepared) {
        if (prepared.toolStartedEvent) {
            const filtered = this.deps.toolTracker.dedupeToolStarted(prepared.toolStartedEvent);
            if (filtered)
                yield filtered;
        }
    }
    recordPendingApproval(context) {
        if (!context.callId) {
            return;
        }
        this.deps.record.recordFunctionCall({
            type: 'function_call',
            callId: context.callId,
            name: context.toolName,
            arguments: context.argumentsText,
        });
    }
    async *applyNextPlan(nextPlan, state, isApproved) {
        if (!isApproved) {
            const callId = getCallIdFromObject(nextPlan.pendingApprovalContext.interruption);
            this.deps.record.recordAbortedApproval('Tool execution was not approved.', 'Tool execution was not approved.', callId);
        }
        if (nextPlan.toolStartedEvent) {
            const filtered = this.deps.toolTracker.dedupeToolStarted(nextPlan.toolStartedEvent);
            if (filtered)
                yield filtered;
        }
        state.source = 'continueRunStream';
        state.inputMode = nextPlan.pendingApprovalContext.inputMode ?? state.inputMode;
        this.deps.record.beginDecisionResolution();
    }
}
//# sourceMappingURL=continuation-plan-applier.js.map