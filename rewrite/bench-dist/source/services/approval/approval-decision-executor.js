import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import { createInvalidToolCallDiagnostic } from '../logging/logging-contract.js';
import { applyApprovalGrant } from './approval-grant-executor.js';
import { resolveSessionId } from '../session/session-identity.js';
/**
 * Applies one already-authorized approval decision to the continuation that
 * owns it. This is deliberately independent of root `ApprovalState`, turn
 * generations, and continuation planning so a transferred child lease can use
 * the exact same capability policy without taking over the root interaction.
 */
export class ApprovalDecisionExecutor {
    deps;
    #toolCallMarkers;
    constructor(deps) {
        this.deps = deps;
        this.#toolCallMarkers = deps.toolCallMarkers ?? new ToolCallMarkerStore();
    }
    resolve(input) {
        const decisionCallId = getCallIdFromObject(input.pendingApprovalContext.interruption);
        try {
            return this.#resolve(input);
        }
        finally {
            if (decisionCallId)
                this.deps.toolOwnership.release(decisionCallId);
        }
    }
    #resolve({ pendingApprovalContext, answer, rejectionReason, source = 'user', }) {
        const { state, interruption } = pendingApprovalContext;
        const decisionCallId = getCallIdFromObject(interruption);
        pendingApprovalContext.decisionsByCallId ??= new Map();
        const { toolName: decisionToolName, rawArguments: decisionRawArguments } = getToolInfoFromInterruption(interruption);
        const grant = applyApprovalGrant({
            sessionId: resolveSessionId(this.deps.sessionId),
            sessionAccess: this.deps.sessionAccess,
            nestedCompatibility: this.deps.nestedCompatibility,
            logger: this.deps.logger,
        }, {
            answer,
            toolName: decisionToolName,
            rawArguments: decisionRawArguments,
            callId: decisionCallId,
            interruption,
        });
        const isApproved = grant.isApproved;
        let toolStartedEvent;
        if (isApproved) {
            this.deps.logger.debug('Tool approval granted', {
                eventType: 'approval.granted',
                category: 'approval',
                phase: 'approval',
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId(),
                ...(grant.deniedReadDecision ? { deniedReadDecision: answer } : {}),
            });
            const { toolName, rawArguments } = getToolInfoFromInterruption(interruption);
            const parseResult = parseToolCallArguments(rawArguments, {
                callId: decisionCallId ?? String(Date.now()),
                toolName,
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId() ?? 'trace-unknown',
            });
            if (parseResult.invalidJsonDiagnostic) {
                const diagnostic = createInvalidToolCallDiagnostic(parseResult.invalidJsonDiagnostic);
                this.deps.logger.error('Invalid tool call argument payload', {
                    ...diagnostic,
                    sessionId: resolveSessionId(this.deps.sessionId),
                    messageId: decisionCallId ?? String(Date.now()),
                });
            }
            const toolCallId = decisionCallId ?? String(Date.now());
            toolStartedEvent =
                pendingApprovalContext.owner.kind === 'subagent'
                    ? {
                        type: 'subagent_tool_started',
                        agentId: pendingApprovalContext.owner.agentId,
                        role: pendingApprovalContext.owner.role,
                        toolCallId,
                        toolName,
                        arguments: parseResult.arguments,
                    }
                    : {
                        type: 'tool_started',
                        toolCallId,
                        toolName,
                        arguments: parseResult.arguments,
                    };
            state.approve?.(interruption);
            if (decisionCallId)
                pendingApprovalContext.decisionsByCallId.set(decisionCallId, 'approved');
        }
        else {
            const message = rejectionReason
                ? `Tool execution was not approved. User's reason: ${rejectionReason}`
                : 'Tool execution was not approved.';
            // Rejection settles an indirect Docker denial, otherwise the same
            // command would require the abandoned prompt again forever.
            if (grant.isDockerRequest && typeof grant.parsedArguments?.command === 'string') {
                if (this.deps.sessionAccess)
                    this.deps.sessionAccess.consumeDockerDenial(grant.parsedArguments.command);
                else
                    this.deps.nestedCompatibility?.docker.consumeDenial(resolveSessionId(this.deps.sessionId), grant.parsedArguments.command);
            }
            this.#toolCallMarkers.markToolCallAsApprovalRejection(decisionCallId);
            state.reject?.(interruption, { message });
            if (decisionCallId)
                pendingApprovalContext.decisionsByCallId.set(decisionCallId, 'rejected');
            this.deps.logger.debug('Tool approval rejected', {
                eventType: 'approval.rejected',
                category: 'approval',
                phase: 'approval',
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId(),
            });
        }
        if (this.deps.hookLifecycle && this.deps.hookEvents) {
            void this.deps.hookLifecycle.emit(this.deps.hookEvents.create('approval.resolved', {
                resolution: isApproved ? (source === 'policy' ? 'auto_approved' : 'approved') : 'rejected',
                source,
                executionFollowed: isApproved,
            }, { toolCallId: decisionCallId }));
        }
        return { pendingApprovalContext, isApproved, toolStartedEvent };
    }
}
//# sourceMappingURL=approval-decision-executor.js.map