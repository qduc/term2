import { createApprovalRequiredTerminal } from '../conversation/conversation-result-builder.js';
import { shouldBypassToolApproval, isAutoApprovableTool, extractToolTargetPaths, } from './shell-auto-approval-resolver.js';
import { supportsFolderSessionRead } from '../../contracts/conversation.js';
import { resolveSessionReadFolder } from './session-read-grant-target.js';
import { asRecord, getCallIdFromObject, getMethod, getString, getToolInfoFromInterruption, } from '../interruption-info.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import { isDockerHostControlShellApproval, isUnsandboxedShell, requiresHumanShellApproval, } from './shell-sandbox-approval.js';
import { resolveSessionId } from '../session/session-identity.js';
export class ToolApprovalBatchCoordinator {
    deps;
    #policyRegistry;
    constructor(deps) {
        this.deps = deps;
        this.#policyRegistry = deps.policyRegistry;
    }
    /**
     * Follow the client's active graph after a mid-session rebuild. Called at
     * fresh-turn boundaries only: an in-flight turn keeps resolving against the
     * graph that produced its interruptions.
     */
    updatePolicyRegistry(registry) {
        this.#policyRegistry = registry;
    }
    async *stageBatch(input) {
        if (this.deps.isCurrent && !this.deps.isCurrent(input.token)) {
            return { kind: 'stale' };
        }
        const pending = this.deps.approvalFlow.getPending();
        if (!pending) {
            return { kind: 'ready' };
        }
        const siblings = input.interruptions ?? this.#interruptionsFor(pending.state, pending.interruptions);
        if (!Array.isArray(siblings) || siblings.length === 0) {
            return { kind: 'ready' };
        }
        if (pending) {
            pending.interruptions ??= siblings;
            pending.decisionsByCallId ??= new Map();
        }
        const runContext = asRecord(asRecord(pending.state)?._context);
        for (const interruption of siblings) {
            if (this.deps.isCurrent && !this.deps.isCurrent(input.token)) {
                return { kind: 'stale' };
            }
            const callId = getCallIdFromObject(interruption);
            const { toolName, argumentsText, rawArguments } = getToolInfoFromInterruption(interruption);
            if (!callId) {
                continue;
            }
            const pendingNow = this.deps.approvalFlow.getPending();
            if (pendingNow?.decisionsByCallId?.has(callId)) {
                continue;
            }
            const parseResult = parseToolCallArguments(rawArguments, {
                callId,
                toolName,
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId() ?? 'trace-unknown',
            });
            const yolo = shouldBypassToolApproval(toolName, this.deps.shellAutoApproval.getAutoApproveMode?.());
            const forceHumanApproval = yolo
                ? false
                : requiresHumanShellApproval(toolName, parseResult.arguments, resolveSessionId(this.deps.sessionId), this.deps.sessionAccess, this.deps.nestedCompatibility, {
                    // Unsandboxed escapes may be evaluated by the LLM auto-approval path
                    // when the sandbox is enabled and auto-approval is in advisory/auto mode.
                    llmMayEvaluateUnsandboxed: this.deps.shellAutoApproval.isUnsandboxedApprovalEligible(),
                });
            const dockerHostControl = isDockerHostControlShellApproval(toolName, parseResult.arguments, resolveSessionId(this.deps.sessionId), this.deps.sessionAccess, this.deps.nestedCompatibility);
            const registryDecision = yolo
                ? { kind: 'auto_approve' }
                : await this.#policyRegistry.evaluate({
                    toolName,
                    args: parseResult.arguments,
                    context: runContext,
                });
            let decision;
            let llmAdvisory;
            if (yolo) {
                decision = 'approve';
            }
            else if (registryDecision.kind === 'interceptor_denied' || registryDecision.kind === 'error') {
                decision = 'reject';
            }
            else if (forceHumanApproval) {
                decision = 'prompt';
            }
            else if (registryDecision.kind === 'auto_approve' && !isUnsandboxedShell(toolName, parseResult.arguments)) {
                decision = 'approve';
            }
            else {
                llmAdvisory =
                    isAutoApprovableTool(toolName) && this.deps.shellAutoApproval.getAutoApproveMode?.() !== 'always'
                        ? await this.deps.shellAutoApproval.resolveAdvisoryForInterruption({
                            interruption,
                            siblings,
                        })
                        : undefined;
                decision = await input.policy.decide({ toolName, argumentsText, callId, llmAdvisory });
            }
            this.deps.approvalFlow.retargetPendingInterruption(interruption);
            const retargeted = this.deps.approvalFlow.getPending();
            if (retargeted) {
                retargeted.interruptions ??= siblings;
                retargeted.decisionsByCallId ??= new Map();
                retargeted.promptedCallId = callId;
            }
            if (decision === 'prompt') {
                if (this.deps.hookLifecycle && this.deps.hookEvents) {
                    void this.deps.hookLifecycle.emit(this.deps.hookEvents.create('approval.requested', {
                        toolName,
                        normalizedArguments: this.deps.hookEvents.includeToolArguments
                            ? parseResult.arguments
                            : JSON.stringify(parseResult.arguments).slice(0, 500),
                        approvalKind: toolName === 'ask_user' ? 'ask_user' : 'tool',
                        proposedDecision: 'approve',
                    }, { toolCallId: callId }));
                }
                this.deps.planApplier.recordPendingApproval({ toolName, argumentsText, callId, llmAdvisory });
                const agent = asRecord(asRecord(interruption)?.agent);
                return {
                    kind: 'approval_required',
                    terminal: createApprovalRequiredTerminal({
                        agentName: getString(agent, 'name') ?? 'Agent',
                        toolName,
                        argumentsText,
                        rawInterruption: interruption,
                        callId,
                        llmAdvisory,
                        dockerHostControl,
                        usage: input.state.cumulativeUsage,
                    }),
                };
            }
            if (decision === 'approve') {
                if (supportsFolderSessionRead(toolName)) {
                    const folder = resolveSessionReadFolder(toolName, parseResult.arguments);
                    if (folder && this.deps.sessionAccess) {
                        this.deps.sessionAccess.allowReadFolder(folder);
                    }
                }
                if (toolName === 'create_file' || toolName === 'search_replace' || toolName === 'apply_patch') {
                    const targetPaths = extractToolTargetPaths(toolName, parseResult.arguments);
                    if (this.deps.sessionAccess) {
                        for (const p of targetPaths) {
                            this.deps.sessionAccess.allowEditFile(p);
                        }
                    }
                }
            }
            const nextPlan = this.deps.approvalFlow.prepareContinuation(decision === 'approve' ? 'y' : 'n', undefined, 'policy');
            if (!nextPlan) {
                throw new Error('Parallel approval batch lost its pending approval context');
            }
            const decidedPending = nextPlan.pendingApprovalContext;
            decidedPending.interruptions ??= siblings;
            decidedPending.decisionsByCallId ??= new Map();
            decidedPending.decisionsByCallId.set(callId, decision === 'approve' ? 'approved' : 'rejected');
            yield* this.deps.planApplier.applyNextPlan(nextPlan, input.state, decision === 'approve');
        }
        return { kind: 'ready' };
    }
    #interruptionsFor(state, fallback) {
        const getInterruptions = getMethod(state, 'getInterruptions');
        const interruptions = getInterruptions?.();
        return Array.isArray(interruptions) ? interruptions : fallback;
    }
}
//# sourceMappingURL=tool-approval-batch-coordinator.js.map