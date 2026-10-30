import { HarnessInvariantError, isCancellationError, isHarnessInvariantError, } from '../../lib/harness-invariant-error.js';
import { describeError } from '../../utils/error-helpers.js';
import { normalizeToolParameters } from '../../lib/tool-invoke.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
/** Owns the planned calls and their approval/execution/settlement lifecycle for one run. */
export class ToolCallExecution {
    #plan;
    #pendingApprovals = [];
    #attempts = new Map();
    #terminateAfterExecution = false;
    #deps;
    constructor(deps) {
        this.#deps = deps;
    }
    get hasPlan() {
        return Boolean(this.#plan);
    }
    get pendingApprovals() {
        return this.#pendingApprovals;
    }
    get terminateAfterExecution() {
        return this.#terminateAfterExecution;
    }
    async plan(events, context) {
        const plan = events.map((event) => {
            context.onCall(event);
            return {
                event,
                definition: context.tools.find((tool) => tool.name === event.name),
                parallelSafe: false,
                status: 'ready',
                ...(context.requestSnapshot ? { requestSnapshot: context.requestSnapshot } : {}),
            };
        });
        this.#plan = plan;
        for (const entry of plan) {
            const { event, definition } = entry;
            if (!definition) {
                entry.output = `Unknown tool: ${event.name}`;
                continue;
            }
            try {
                const parsedArguments = definition.parseModelArguments
                    ? definition.parseModelArguments(event.arguments)
                    : parseArguments(event.arguments);
                entry.params = normalizeToolParameters(parsedArguments, definition.parameters);
            }
            catch (error) {
                entry.output = `Error: Invalid patch: ${describeError(error)}`;
                continue;
            }
            if (definition.parseModelArguments) {
                const mismatch = parsedArgumentsSchemaMismatch(definition, entry.params);
                if (mismatch) {
                    entry.output = mismatch;
                    this.#log('parsed tool arguments rejected by schema', { toolName: event.name, callId: event.id }, 'tool.arguments.schema_rejected');
                    continue;
                }
            }
            context.onToolStall({ name: event.name, argumentsText: event.arguments, effect: definition.effect });
            // Only blanket decisions apply to a newly planned call. A per-call
            // approval or rejection is bound to its plan entry (resolveApproval) and
            // must never authorize a later call that reuses the same id.
            const alreadyDecided = context.approvals.blanketDecision(event.name);
            if (alreadyDecided === false) {
                entry.output = context.approvals.blanketRejectionMessage(event.name) ?? 'Tool execution was not approved.';
                continue;
            }
            if (alreadyDecided !== true && (await definition.needsApproval(entry.params, context.toolContext))) {
                entry.status = 'approval_pending';
                this.#pendingApprovals.push({
                    callId: event.id,
                    toolName: event.name,
                    argumentsText: event.arguments,
                    interruption: {
                        type: 'tool_approval_item',
                        rawItem: {
                            type: 'function_call',
                            callId: event.id,
                            name: event.name,
                            arguments: event.arguments,
                            ...(event.providerMetadata ? { providerData: event.providerMetadata } : {}),
                        },
                        callId: event.id,
                        name: event.name,
                        arguments: event.arguments,
                    },
                    definition,
                    params: entry.params,
                    plan: entry,
                });
                continue;
            }
            entry.parallelSafe = await isParallelSafe(definition, entry.params, context.toolContext);
        }
        this.#logEligibility(plan);
    }
    /**
     * Settle exactly the pending call the decision was made for. The interruption
     * object the caller answered identifies it: call ids are not unique (a
     * provider may give several calls in one response the same id, and a later
     * response may reuse an earlier one's id), so an interruption that names a
     * call but is not one of the pending interruption objects — a copy, or a
     * stale one from an earlier pause — fails closed instead of being matched by
     * id. Every in-process caller answers with the object it was handed. Only a
     * bare call id with no interruption object may select by id, and only when
     * that id is unique among the pending calls.
     */
    validateApprovalBatch(batch) {
        const seen = new Set();
        for (const decision of batch) {
            const pending = this.#pendingApprovals.find((entry) => entry.interruption === decision.interruption);
            if (!pending || seen.has(decision.interruption) || decision.callId !== pending.callId) {
                throw new HarnessInvariantError('Approval batch references a stale, copied, duplicate or inconsistent interruption');
            }
            seen.add(decision.interruption);
        }
    }
    resolveApproval(target, decision, message, approvals) {
        const { callId, interruption } = target;
        let selectedIndex = -1;
        if (interruption !== undefined) {
            selectedIndex = this.#pendingApprovals.findIndex((pending) => pending.interruption === interruption);
            if (selectedIndex < 0 && callId)
                throw new Error(`Approval decision references an interruption that is not pending in this run (stale or copied): ${callId}`);
        }
        else if (callId) {
            const matches = this.#pendingApprovals.filter((pending) => pending.callId === callId);
            if (matches.length > 1)
                throw new Error(`Approval decision call id is ambiguous among pending tool calls: ${callId}`);
            selectedIndex = matches.length === 1 ? this.#pendingApprovals.indexOf(matches[0]) : -1;
        }
        if (callId && selectedIndex < 0)
            throw new Error(`Approval decision references unknown pending tool call: ${callId}`);
        const pendingIndex = selectedIndex >= 0 ? selectedIndex : 0;
        const pending = this.#pendingApprovals[pendingIndex];
        if (!pending)
            throw new Error('Approval decision has no pending tool call');
        const approved = decision === 'approved';
        if (approved)
            approvals.approveTool({ toolName: pending.toolName, callId: pending.callId });
        else
            approvals.rejectTool({ toolName: pending.toolName, callId: pending.callId }, { message });
        pending.plan.status = 'ready';
        if (!approved)
            pending.plan.output = message ?? 'rejected';
        this.#pendingApprovals.splice(pendingIndex, 1);
    }
    async settle(context) {
        const plan = this.#plan;
        if (!plan)
            return;
        const maxParallelToolCalls = Math.max(1, Math.floor(this.#deps.resolveMaxParallelToolCalls?.() ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS));
        while (true) {
            const firstPending = plan.find((entry) => entry.status !== 'completed');
            if (!firstPending) {
                this.#plan = undefined;
                return;
            }
            if (firstPending.status === 'approval_pending')
                return;
            const group = [];
            for (const entry of plan) {
                if (entry.status === 'completed')
                    continue;
                if (entry.status === 'approval_pending')
                    break;
                if (group.length > 0 && (!entry.parallelSafe || !group[0].parallelSafe || group.length >= maxParallelToolCalls))
                    break;
                group.push(entry);
                if (!entry.parallelSafe)
                    break;
            }
            const batchId = `tool-batch-${++nextToolBatchSeq}`;
            this.#log('tool batch dispatched', {
                batchId,
                callIds: group.map((entry) => entry.event.id),
                parallel: group.length > 1,
                maxParallelToolCalls,
                dispatchOrder: group.map((entry) => entry.event.id),
            }, 'tool.batch.dispatched');
            if (!context.beforeToolDispatch)
                for (const entry of group)
                    context.onDispatch(entry);
            const results = group.length > 1
                ? await Promise.allSettled(group.map((entry) => this.#invoke(entry, context)))
                : [{ status: 'fulfilled', value: await this.#invoke(group[0], context) }];
            const rejected = results.find((result) => result.status === 'rejected');
            // Preserve every known outcome before a sibling's failure enters recovery.
            for (const [index, result] of results.entries()) {
                if (result.status !== 'fulfilled')
                    continue;
                const value = result.value;
                group[index].result = value;
                context.onResult(group[index], value);
            }
            if (rejected)
                throw rejected.reason;
            this.#log('tool batch settled', {
                batchId,
                callIds: group.map((entry) => entry.event.id),
                settlementOrder: group.map((entry) => entry.event.id),
            }, 'tool.batch.settled');
            if (group.some((entry) => shouldTerminateAfterExecution(entry.definition, entry.result))) {
                this.#terminateAfterExecution = true;
                this.#plan = undefined;
                return;
            }
        }
    }
    #logEligibility(plan) {
        this.#deps.logDiagnostic?.('tool parallel eligibility', {
            decisions: plan.map((entry) => ({
                callId: entry.event.id,
                toolName: entry.event.name,
                parallelSafe: entry.parallelSafe,
                approvalPending: entry.status === 'approval_pending',
            })),
        }, { severity: 'debug', eventType: 'tool.parallel.eligibility' });
    }
    #log(message, meta, eventType) {
        this.#deps.logDiagnostic?.(message, meta, { severity: 'debug', eventType });
    }
    async #invoke(entry, context) {
        if (entry.output !== undefined) {
            entry.status = 'completed';
            return entry.output;
        }
        const definition = entry.definition;
        const callId = entry.event.id;
        const startedAt = Date.now();
        const attempt = (this.#attempts.get(callId) ?? 0) + 1;
        this.#attempts.set(callId, attempt);
        const lifecycleContext = {
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.turnId ? { turnId: context.turnId } : {}),
            toolCallId: callId,
            toolName: definition.name,
            normalizedArguments: entry.params,
            attempt,
            scope: context.hookScope ?? 'root',
        };
        if (context.beforeToolDispatch) {
            await context.beforeToolDispatch(callId);
            context.onDispatch(entry);
        }
        entry.status = 'completed';
        context.onExecutionStarted(callId);
        await this.#notify(() => this.#deps.toolLifecycle?.before(lifecycleContext));
        try {
            const details = {
                toolCall: { callId },
                ...(entry.requestSnapshot ? { request: entry.requestSnapshot } : {}),
            };
            const result = await definition.execute(entry.params, context.toolContext, details);
            await this.#notify(() => this.#deps.toolLifecycle?.after(lifecycleContext, result, Date.now() - startedAt));
            return result;
        }
        catch (error) {
            const maxTurns = this.#deps.isMaxTurnsExceeded?.(error) ?? false;
            if (isCancellationError(error) || isHarnessInvariantError(error) || maxTurns) {
                await this.#notify(() => this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, false));
                throw error;
            }
            const result = `Error: ${describeError(error)}`;
            await this.#notify(() => this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, true));
            return result;
        }
    }
    async #notify(operation) {
        if (!operation)
            return;
        try {
            await operation();
        }
        catch {
            // Lifecycle observers are passive and cannot change tool execution.
        }
    }
}
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 3;
let nextToolBatchSeq = 0;
function parsedArgumentsSchemaMismatch(definition, params) {
    const schema = definition.canonicalParameters ??
        (isZodToolParameterSchema(definition.parameters) ? definition.parameters : undefined);
    if (!schema || !isZodToolParameterSchema(schema) || schema.safeParse(params).success)
        return undefined;
    return `Error: ${definition.name} argument parser returned a value its schema rejects. This is a harness defect.`;
}
function parseArguments(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return {};
    }
}
async function isParallelSafe(definition, params, context) {
    if (typeof definition.parallelSafe === 'function') {
        try {
            return await definition.parallelSafe(params, context);
        }
        catch {
            return false;
        }
    }
    return definition.parallelSafe === true;
}
function shouldTerminateAfterExecution(definition, result) {
    const policy = definition?.terminateAfterExecution;
    if (typeof policy === 'boolean')
        return policy;
    if (!policy)
        return false;
    try {
        return policy(result);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=tool-call-execution.js.map