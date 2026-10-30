import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import { validateApprovalGrant } from './approval-grant-executor.js';
import { ApprovalDecisionExecutor } from './approval-decision-executor.js';
import { isRunBudgetInteraction } from '../agent-runtime/run-budget.js';
import { resolveSessionId } from '../session/session-identity.js';
export class ApprovalFlowCoordinator {
    deps;
    #toolOwnership;
    #toolCallMarkers;
    #decisionExecutor;
    constructor(deps) {
        this.deps = deps;
        this.#toolOwnership = deps.toolOwnership;
        this.#toolCallMarkers = deps.toolCallMarkers ?? new ToolCallMarkerStore();
        this.#decisionExecutor = new ApprovalDecisionExecutor({
            logger: deps.logger,
            sessionId: deps.sessionId,
            toolOwnership: deps.toolOwnership,
            sessionAccess: deps.sessionAccess,
            nestedCompatibility: deps.nestedCompatibility,
            hookLifecycle: deps.hookLifecycle,
            hookEvents: deps.hookEvents,
            toolCallMarkers: this.#toolCallMarkers,
        });
    }
    /**
     * Which agent issued this pending tool call. A subagent claims its own
     * approvals when it raises them; anything unclaimed is the parent's.
     */
    resolveOwner(interruption) {
        return this.#toolOwnership.ownerOf(getCallIdFromObject(interruption));
    }
    buildApprovalDecision(answer, rejectionReason, stopAfterApprovalResolution) {
        return {
            kind: 'approval_decision',
            decisionAddress: this.deps.approvalState.getPending()?.interruption,
            answer,
            rejectionReason,
            generation: this.deps.approvalState.getPending()?.token ?? 0,
            ...(stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
        };
    }
    /** Pure adopted preflight; mutation remains in prepareContinuation. */
    validateGrant(answer, approval) {
        const pending = this.deps.approvalState.getPending();
        if (!pending || pending.interruption !== approval.rawInterruption)
            throw new Error('Approval authority is stale');
        const info = getToolInfoFromInterruption(pending.interruption);
        validateApprovalGrant({
            sessionId: resolveSessionId(this.deps.sessionId),
            sessionAccess: this.deps.sessionAccess,
            nestedCompatibility: this.deps.nestedCompatibility,
            logger: this.deps.logger,
        }, {
            answer,
            toolName: info.toolName,
            rawArguments: info.rawArguments,
            callId: getCallIdFromObject(pending.interruption),
            interruption: pending.interruption,
        }, approval);
    }
    abort() {
        this.deps.agentClient.abort();
        const pending = this.deps.approvalState.getPending();
        const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
        if (this.deps.approvalState.abortPending()) {
            if (callId)
                this.#toolOwnership.release(callId);
            this.deps.record.markOpenCallsAborted('Tool execution was not approved.', callId);
            this.deps.logger.debug('Aborted approval - abandoning pending tool before next message', {
                eventType: 'approval.aborted',
                category: 'approval',
                phase: 'abort',
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId(),
            });
            return { aborted: true, callId };
        }
        return { aborted: false };
    }
    consumeAborted() {
        return this.deps.approvalState.consumeAborted();
    }
    getAbortedStatus() {
        const aborted = this.deps.approvalState.consumeAborted();
        if (!aborted) {
            return { kind: 'none' };
        }
        const tokenVal = aborted.token ?? 0;
        if (this.deps.generationGuard.isCurrent(tokenVal)) {
            return { kind: 'current', context: aborted };
        }
        return { kind: 'stale' };
    }
    /**
     * Drive an aborted-approval resolution: install rejection interceptor and approve the
     * interruption so the agent gets the rejection text via the interceptor.
     * For nested subagent approvals, use SDK-native reject() instead of the
     * parent interceptor path to avoid interceptor stacking issues.
     */
    prepareAbortResolution(abortedContext, userText) {
        const expectedCallId = getCallIdFromObject(abortedContext.interruption);
        const rejectionMessage = `Tool execution was not approved. User provided new input instead: ${userText}`;
        this.#toolCallMarkers.markToolCallAsApprovalRejection(expectedCallId);
        abortedContext.state.reject?.(abortedContext.interruption, { message: rejectionMessage });
        abortedContext.decisionsByCallId ??= new Map();
        if (expectedCallId) {
            abortedContext.decisionsByCallId.set(expectedCallId, 'rejected');
        }
        return { abortedContext };
    }
    /**
     * Prepare for a continuation after the user makes an approval decision.
     * Returns null if there is no pending approval.
     */
    prepareContinuation(answer, rejectionReason, source = 'user') {
        const pendingApprovalContext = this.deps.approvalState.getPending();
        if (!pendingApprovalContext) {
            return null;
        }
        // A run-budget check-in is deliberately carried by the same continuation
        // state as tool approvals, but it has no capability decision to apply.
        if (isRunBudgetInteraction(pendingApprovalContext.interruption)) {
            return { pendingApprovalContext };
        }
        const result = this.#decisionExecutor.resolve({
            pendingApprovalContext,
            answer,
            rejectionReason,
            source,
        });
        return { pendingApprovalContext, toolStartedEvent: result.toolStartedEvent };
    }
    recordPending(pending) {
        this.deps.approvalState.setPending(pending);
    }
    clearPending() {
        this.deps.approvalState.clearPending();
    }
    getPending() {
        return this.deps.approvalState.getPending();
    }
    getPendingInterruption() {
        return this.deps.approvalState.getPending()?.interruption;
    }
    retargetPendingInterruption(interruption) {
        const pending = this.deps.approvalState.getPending();
        if (!pending) {
            return null;
        }
        this.deps.approvalState.setPending({
            ...pending,
            interruption,
            promptedCallId: getCallIdFromObject(interruption),
            owner: this.resolveOwner(interruption),
        });
        return this.deps.approvalState.getPending();
    }
}
//# sourceMappingURL=approval-flow-coordinator.js.map