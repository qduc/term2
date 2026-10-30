import { resolveAgentSpecForChild, } from '../../../services/agent-runtime/permission-boundary.js';
import { applyApprovalGrant } from '../../../services/approval/approval-grant-executor.js';
import { RUN_CODE_LIMITS } from './run-code-runtime.js';
const ASYNC_LIFECYCLE_MEMBERS = ['start', 'status', 'result', 'cancel'];
const isFunction = (value) => typeof value === 'function';
/** True when at least one launch seam exists; gates capability existence. */
export function isRunCodeAgentBridgeActive(bridge) {
    if (!bridge)
        return false;
    const foreground = isFunction(bridge.runResolvedSubagent);
    const asyncLifecycle = isFunction(bridge.runResolvedSubagentAsync) &&
        isFunction(bridge.getSubagentResult) &&
        isFunction(bridge.getSubagentStatus) &&
        isFunction(bridge.cancelSubagentRun);
    return foreground || asyncLifecycle;
}
/** The exact member list a bound bridge can serve; also rendered into the tool description. */
export function getRunCodeAgentCapabilityMembers(bridge) {
    const members = [];
    if (isFunction(bridge.runResolvedSubagent))
        members.push('run');
    if (isFunction(bridge.runResolvedSubagentAsync) &&
        isFunction(bridge.getSubagentResult) &&
        isFunction(bridge.getSubagentStatus) &&
        isFunction(bridge.cancelSubagentRun)) {
        members.push(...ASYNC_LIFECYCLE_MEMBERS);
    }
    return members;
}
const isRecord = (value) => typeof value === 'object' && value !== null;
const rejectCall = (error) => ({
    kind: 'result',
    result: { ok: false, error },
});
const isAbortError = (error) => error instanceof Error && error.name === 'AbortError';
/**
 * Extracts the pending tool call from a child run-loop interruption. Other
 * interruption kinds — e.g. a child run-budget check-in — are not tool
 * approvals: the caller leaves those pauses unapplied, so the child settles
 * interrupted and the script keeps its existing catchable error.
 */
function extractChildToolApproval(interruption) {
    if (!isRecord(interruption) || interruption.type !== 'tool_approval_item')
        return undefined;
    if (typeof interruption.name !== 'string' || interruption.name === '')
        return undefined;
    const argumentsText = typeof interruption.arguments === 'string' ? interruption.arguments : JSON.stringify(interruption.arguments ?? {});
    let argumentsValue = {};
    try {
        argumentsValue = JSON.parse(argumentsText);
    }
    catch {
        // Registry evaluation is fail-closed for arguments it cannot inspect.
    }
    return {
        toolName: interruption.name,
        argumentsText,
        arguments: argumentsValue,
        ...(typeof interruption.callId === 'string' ? { callId: interruption.callId } : {}),
    };
}
/** `costRecords` and `nestedRunResult` are host-owned: possibly large, possibly not JSON-safe. */
const projectNestedResult = (result) => {
    const { costRecords: _costRecords, nestedRunResult: _nestedRunResult, ...projected } = result;
    // The host re-serializes capability results through JSON, so any plain-data
    // projection is transportable even without a JsonValue index signature.
    return projected;
};
const AGENT_MEMBERS = ['run', 'start', 'status', 'result', 'cancel'];
const LAUNCH_PARAM_FIELDS = new Set(['spec', 'worktree', 'name', 'continue_run_id']);
/** Light, admission-time param checks. Deep AgentSpec validation is the boundary's job. */
function launchParamError(member, params) {
    const accepted = member === 'run' ? new Set(['spec', 'worktree']) : LAUNCH_PARAM_FIELDS;
    for (const key of Object.keys(params)) {
        if (!accepted.has(key))
            return `unsupported param "${key}"; agent.${member} accepts ${[...accepted].join(', ')}.`;
    }
    if (!isRecord(params.spec) || Array.isArray(params.spec))
        return 'spec must be a plain AgentSpec object.';
    if (params.worktree !== undefined && typeof params.worktree !== 'string')
        return 'worktree must be a string.';
    if (params.name !== undefined && typeof params.name !== 'string')
        return 'name must be a string.';
    if (params.continue_run_id !== undefined && typeof params.continue_run_id !== 'string') {
        return 'continue_run_id must be a string.';
    }
    if (member === 'start' && params.continue_run_id !== undefined) {
        return 'continue_run_id is not supported by script agent.start until continuation authority can be verified.';
    }
    return undefined;
}
function lifecycleParamError(member, params) {
    const accepted = member === 'status' ? new Set(['runId']) : new Set([member === 'result' ? 'runId' : 'target']);
    for (const key of Object.keys(params)) {
        if (!accepted.has(key))
            return `unsupported param "${key}"; agent.${member} accepts ${[...accepted].join(', ')}.`;
    }
    const required = member === 'cancel' ? 'target' : 'runId';
    if (member !== 'status' && (params[required] === undefined || typeof params[required] !== 'string')) {
        return `${required} must be a string.`;
    }
    if (member === 'status' && params.runId !== undefined && typeof params.runId !== 'string') {
        return 'runId must be a string.';
    }
    return undefined;
}
/**
 * The script-only `agent` capability of one run_code invocation.
 *
 * Every launch resolves an untrusted script AgentSpec through
 * `resolveAgentSpecForChild` against the host-bound root authority snapshot
 * before any bridge callback sees it; the boundary result — never the raw
 * spec — is what reaches the host bridge. Start admission is a synchronous
 * check-and-increment before resolution, so a script can never race itself
 * past the launch cap, and an over-cap start is rejected before the manager
 * launches anything while already-admitted siblings continue untouched.
 */
export function createRunCodeAgentCapability(deps, invocation) {
    const members = getRunCodeAgentCapabilityMembers(deps);
    if (members.length === 0) {
        throw new Error('run_code agent capability requires a resolved-launch or async lifecycle bridge.');
    }
    // Synchronous admission counter: `prepare` never awaits between the cap
    // check and the increment, so concurrent script starts cannot exceed it.
    let startsAdmitted = 0;
    /**
     * Builds the per-call publisher that surfaces one foreground child approval
     * pause through the session-owned decision owner. The capability attaches it
     * only when the session owner and policy registry are bound; the decision is
     * applied to the pause's exact retained continuation through `pause.apply`,
     * never from script data, and the human wait is bracketed with the host
     * work-clock hooks so paused children do not burn the script timeout.
     */
    const childApprovalPublisher = (callContext) => {
        const owner = deps.nestedApprovalOwner;
        const registry = deps.approvalPolicyRegistry;
        if (!owner || !registry)
            return undefined;
        return async (pause) => {
            const approvalInfo = extractChildToolApproval(pause.interruption);
            // Not a tool approval (e.g. a child run-budget check-in): leave the pause
            // unapplied so the child settles interrupted and the script keeps its
            // existing catchable error.
            if (!approvalInfo)
                return;
            // The host wraps these on the handler per run; the clock pauses only
            // while every admitted call is waiting.
            handler.onWaiting?.(callContext);
            try {
                const resolution = await owner.request({
                    requestId: `${pause.runId}:child-approval:${pause.generation}`,
                    sessionId: deps.sessionId ?? 'unknown',
                    graphIdentity: deps.graphIdentity ?? {},
                    outerRunId: invocation.bridgeRunId,
                    nestedCallId: pause.runId,
                    toolName: approvalInfo.toolName,
                    preparedArguments: approvalInfo.arguments,
                    authorityContext: invocation.context,
                    approval: {
                        agentName: `Script child agent (${pause.role})`,
                        toolName: approvalInfo.toolName,
                        argumentsText: approvalInfo.argumentsText,
                        rawInterruption: null,
                        ...(approvalInfo.callId !== undefined ? { callId: approvalInfo.callId } : {}),
                    },
                    signal: callContext.signal,
                    revalidate: async () => (await registry.evaluate({
                        toolName: approvalInfo.toolName,
                        args: approvalInfo.arguments,
                        context: invocation.context,
                    })).kind,
                    grant: (decision) => {
                        if (callContext.signal.aborted)
                            throw new Error('Tool execution was not approved.');
                        // Nested edit tools have no session edit-grant store. Do not claim
                        // a durable child edit authorization by mutating the root's state.
                        if (decision.answer === 'allow-edit-file-session' || decision.answer === 'allow-edit-folder-session') {
                            throw new Error('Session edit grants are unavailable for script child agents.');
                        }
                        // Session-owned grant memory (allow-session edits, docker, denied
                        // reads) applies exactly as the direct child approval path does.
                        const applied = applyApprovalGrant({
                            sessionId: deps.sessionId ?? 'unknown',
                            nestedCompatibility: deps.nestedCompatibility,
                            logger: deps.logger,
                        }, {
                            answer: decision.answer,
                            toolName: approvalInfo.toolName,
                            rawArguments: approvalInfo.argumentsText,
                            callId: approvalInfo.callId,
                            interruption: pause.interruption,
                        });
                        if (!applied.isApproved)
                            throw new Error('Tool execution was not approved.');
                        // One decision on the exact retained continuation: `apply` consumes
                        // only this pause's generation and returns false when stale.
                        const resumed = pause.apply(({ handle, interruption }) => {
                            handle.approve?.(interruption);
                            return true;
                        });
                        if (!resumed)
                            throw new Error('The child approval pause is no longer current.');
                    },
                    // The child's own loop dispatches after its continuation is approved;
                    // the host owns no tool call to run here.
                    dispatch: async () => true,
                });
                if (resolution.kind === 'denied') {
                    pause.apply(({ handle, interruption }) => {
                        handle.reject?.(interruption, { message: resolution.message });
                        return true;
                    });
                }
                // `approved`: the grant already resumed the exact child continuation.
                // `failed`: the grant threw before or while applying; the lease queue
                // settles the child so the script keeps a truthful outcome.
            }
            finally {
                handler.onResumed?.(callContext);
            }
        };
    };
    const handler = {
        binding: { name: 'agent', kind: 'namespace', members },
        limits: {
            maxCalls: RUN_CODE_LIMITS.maxAgentCalls,
            maxConcurrency: RUN_CODE_LIMITS.maxAgentConcurrency,
            limitExceededMessage: `Agent call limit reached (${RUN_CODE_LIMITS.maxAgentCalls} agent.* calls per script run).`,
        },
        overBudget: ({ usedCalls, maxCalls }) => rejectCall(`Agent call limit reached (${maxCalls} agent.* calls per script run; ${usedCalls} admitted, ${Math.max(0, maxCalls - usedCalls)} remaining). Return the partial results you collected.`),
        onAdmitted: (prepared, context) => {
            const callId = `${invocation.bridgeRunId}:agent:${context.callId}`;
            deps.onCallAdmitted?.(prepared.member, prepared.started, callId);
        },
        onAborted: (prepared, context, reason) => {
            const callId = `${invocation.bridgeRunId}:agent:${context.callId}`;
            deps.onCallSettled?.(prepared.member, prepared.started, callId, 'unknown', reason);
        },
        lane: (prepared) => (prepared.member === 'run' || prepared.member === 'start' ? 'default' : 'serial'),
        prepare: (payload) => {
            const started = Date.now();
            const requested = typeof payload.member === 'string' ? payload.member : '';
            if (!AGENT_MEMBERS.includes(requested)) {
                return rejectCall(`Unknown agent member "${requested}". Available: ${members.join(', ')}.`);
            }
            const member = requested;
            const params = isRecord(payload.params) ? payload.params : {};
            if (member === 'run' || member === 'start') {
                const paramError = launchParamError(member, params);
                if (paramError)
                    return rejectCall(`agent.${member} params invalid: ${paramError}`);
                // Admit the start before resolving so the cap holds regardless of what
                // resolution does; a rejected spec consumes its admission like a
                // launched one would, keeping the budget an honest upper bound.
                if (startsAdmitted >= RUN_CODE_LIMITS.maxAgentStarts) {
                    return rejectCall(`Agent start limit reached (${RUN_CODE_LIMITS.maxAgentStarts} agent launches per script run; ` +
                        `${startsAdmitted} admitted, 0 remaining). Return the partial results you collected; ` +
                        'admitted launches are unaffected.');
                }
                startsAdmitted += 1;
                const boundary = resolveAgentSpecForChild(params.spec, {
                    settings: deps.settings,
                    logger: deps.logger,
                    parent: deps.authority.parent,
                    readOnly: deps.authority.readOnly,
                    planMode: deps.authority.planMode,
                    ...(typeof params.worktree === 'string' ? { worktree: params.worktree } : {}),
                });
                if (!boundary.ok) {
                    return rejectCall(`Agent specification rejected: ${boundary.errors.map((error) => error.message).join('; ')}`);
                }
                return member === 'run'
                    ? { member, boundary, started }
                    : {
                        member,
                        boundary,
                        ...(typeof params.name === 'string' ? { name: params.name } : {}),
                        started,
                    };
            }
            const lifecycleError = lifecycleParamError(member, params);
            if (lifecycleError)
                return rejectCall(`agent.${member} params invalid: ${lifecycleError}`);
            if (member === 'status') {
                return {
                    member,
                    ...(typeof params.runId === 'string' ? { runId: params.runId } : {}),
                    started,
                };
            }
            if (member === 'result') {
                return { member, runId: params.runId, started };
            }
            return { member: 'cancel', target: params.target, started };
        },
        invoke: async (prepared, callContext) => {
            const callId = `${invocation.bridgeRunId}:agent:${callContext.callId}`;
            try {
                const outcome = await (async () => {
                    if (prepared.member === 'run') {
                        try {
                            const publisher = childApprovalPublisher(callContext);
                            const nested = await deps.runResolvedSubagent.call(undefined, {
                                resolvedDefinition: prepared.boundary,
                                ...(publisher ? { foregroundChildApproval: publisher } : {}),
                            }, invocation.context, 
                            // The host controller signal aborts the child on script timeout or
                            // cancellation; the tool call id keeps foreground leases movable.
                            {
                                toolCall: { callId: `${invocation.bridgeRunId}:agent:${callContext.callId}` },
                                signal: callContext.signal,
                            });
                            if (nested.status === 'interrupted') {
                                return rejectCall('Child run interrupted (possibly awaiting a tool approval). The script cannot resume ' +
                                    'this foreground child; use the direct subagent tool for approval-interactive work.');
                            }
                            return { kind: 'result', result: { ok: true, result: projectNestedResult(nested) } };
                        }
                        catch (error) {
                            if (callContext.signal.aborted || isAbortError(error))
                                throw error;
                            return rejectCall(error instanceof Error ? error.message : String(error));
                        }
                    }
                    if (prepared.member === 'start') {
                        try {
                            const handle = await deps.runResolvedSubagentAsync.call(undefined, {
                                resolvedDefinition: prepared.boundary,
                                ...(prepared.name ? { name: prepared.name } : {}),
                            });
                            return {
                                kind: 'result',
                                result: {
                                    ok: true,
                                    result: {
                                        runId: handle.runId,
                                        ...(handle.name ? { name: handle.name } : {}),
                                        role: handle.role,
                                        status: handle.status,
                                    },
                                },
                            };
                        }
                        catch (error) {
                            // Launch failures are script-catchable; the background run is never
                            // bound to this script's signal, so there is no abort case here.
                            return rejectCall(error instanceof Error ? error.message : String(error));
                        }
                    }
                    if (prepared.member === 'status') {
                        const status = deps.getSubagentStatus.call(undefined, prepared.runId !== undefined ? { runId: prepared.runId } : {}, invocation.context);
                        return { kind: 'result', result: { ok: true, result: status } };
                    }
                    if (prepared.member === 'result') {
                        try {
                            const settled = await deps.getSubagentResult.call(undefined, { runId: prepared.runId }, invocation.context, {
                                signal: callContext.signal,
                            });
                            return { kind: 'result', result: { ok: true, result: projectNestedResult(settled) } };
                        }
                        catch (error) {
                            if (callContext.signal.aborted || isAbortError(error))
                                throw error;
                            return rejectCall(error instanceof Error ? error.message : String(error));
                        }
                    }
                    const acknowledgement = deps.cancelSubagentRun.call(undefined, { target: prepared.target });
                    return { kind: 'result', result: { ok: true, result: acknowledgement } };
                })();
                const result = outcome.kind === 'result' && isRecord(outcome.result) ? outcome.result : undefined;
                const failed = outcome.kind === 'fail' || result?.ok === false;
                const reason = failed && typeof result?.error === 'string' ? result.error : undefined;
                deps.onCallSettled?.(prepared.member, prepared.started, callId, failed ? 'error' : 'ok', reason);
                return outcome;
            }
            catch (error) {
                deps.onCallSettled?.(prepared.member, prepared.started, callId, 'error', error instanceof Error ? error.message : String(error));
                throw error;
            }
        },
    };
    return handler;
}
//# sourceMappingURL=run-code-agent-capability.js.map