import { randomUUID } from 'node:crypto';
import { createSubagentRuntime } from './runtime.js';
import { isAbortLike, safeEmit } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import { adaptLegacyRole, adaptLegacyDefinition } from '../agent-runtime/legacy-adapter.js';
import { createAgentRuntimeFromSubagentRuntime } from '../agent-runtime/compose-agent-runtime.js';
import { createRootBudget } from '../agent-runtime/execution-budget.js';
import { agentSpecToConfig } from '../agent-runtime/agent-spec.js';
import { SubagentRegistryError } from './subagent-async-registry.js';
export class SubagentManager {
    #logger;
    #settings;
    #onEvent;
    #runtime;
    #skillsService;
    #mentorActive = false;
    constructor(deps) {
        this.#logger = deps.logger;
        this.#settings = deps.settings;
        this.#skillsService = deps.skillsService;
        this.#onEvent = deps.onEvent;
        this.#runtime = createSubagentRuntime(deps);
    }
    resetMentorSession() {
        // Agent configuration rebuilds call this while a retained session starts
        // its successor turn. Async runs are conversation-owned, not mentor-cache
        // state: explicit interruption/disposal paths call cancelAllAsyncRuns (or
        // dispose) and must remain the only paths that stop them.
        this.#runtime.mentorRunner.reset();
    }
    clearCache() {
        this.#runtime.nestedRunner.clearCache();
    }
    /** Exact state shared by nested-tool execution and approval policy. */
    getNestedToolCompatibilityState() {
        return this.#runtime.nestedCompatibility;
    }
    /** Session-owned delivery path for approvals that arrive after adoption. */
    setBackgroundApprovalPauseSink(sink) {
        this.#runtime.nestedRunner.setBackgroundApprovalPauseSink(sink);
    }
    getRoleAgentTool(role) {
        return this.#runtime.nestedRunner.getRoleAgentTool(role);
    }
    getRoleAgent(role) {
        return this.#runtime.nestedRunner.getRoleAgent(role);
    }
    async runAsTool(request, context, details) {
        if (request.agentSpec || request.resolvedDefinition) {
            const resolvedDefinition = request.resolvedDefinition
                ? { ...request.resolvedDefinition, isScriptGeneric: true }
                : this.#resolveAgentSpec(request.agentSpec, request.executionBudget);
            return this.#runtime.nestedRunner.runAsTool({ ...request, role: 'agent', task: request.agentSpec?.goal ?? request.task, resolvedDefinition }, context, details);
        }
        return this.#runtime.nestedRunner.runAsTool(request, context, details);
    }
    /**
     * Obtain an AgentRuntime backed by this manager's existing subagent
     * infrastructure (shared tool policy, execution runner, mentor runner).
     * Avoids creating duplicate independent tool policies. The returned
     * runtime's handles execute through the same ExecutionSubagentRunner
     * and MentorRunner used by this manager.
     */
    getAgentRuntime() {
        return createAgentRuntimeFromSubagentRuntime({
            settings: this.#settings,
            logger: this.#logger,
            skillsService: this.#skillsService,
            executionRunner: this.#runtime.executionRunner,
            mentorRunner: this.#runtime.mentorRunner,
            onEvent: this.#onEvent,
        });
    }
    /**
     * Resolve a role to a legacy SubagentDefinition through the shared
     * ResolvedAgentDefinition adaptation path. This ensures all role
     * definitions (explorer/worker/mentor) pass through the
     * same resolution before execution.
     */
    #resolveRoleDefinition(role) {
        const resolved = adaptLegacyRole(role, this.#settings);
        return adaptLegacyDefinition(resolved);
    }
    #resolveAgentSpec(spec, inheritedBudget) {
        if (spec.budget) {
            const unsupported = Object.keys(spec.budget).filter((key) => key !== 'maxTurns' && key !== 'maxTokens');
            if (unsupported.length > 0) {
                throw new Error(`Unsupported AgentSpec budget fields in delegated runs: ${unsupported.join(', ')}`);
            }
            for (const key of ['maxTurns', 'maxTokens']) {
                const value = spec.budget[key];
                if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
                    throw new Error(`AgentSpec budget.${key} must be a positive integer.`);
                }
            }
        }
        const runtime = this.getAgentRuntime();
        const definition = runtime.resolveDefinition(agentSpecToConfig(spec));
        if (definition.resolutionErrors.length > 0) {
            throw new Error(`Agent specification rejected: ${definition.resolutionErrors.map((error) => error.message).join('; ')}`);
        }
        const budget = inheritedBudget ??
            createRootBudget({
                maxChildren: definition.limits.maxChildren,
                maxDepth: definition.limits.maxDepth,
                maxConcurrency: definition.limits.maxConcurrency,
                maxTokens: definition.limits.maxTokens,
            });
        const adapted = {
            ...adaptLegacyDefinition(definition, budget),
            isScriptGeneric: true,
            isRootExecution: inheritedBudget === undefined,
        };
        return adapted;
    }
    async run(request) {
        const agentId = randomUUID();
        this.#logger.debug('SubagentManager.run', { agentId, role: request.role, taskLength: request.task.length });
        await safeEmit(this.#logger, this.#onEvent, {
            type: 'subagent_started',
            agentId,
            role: request.role,
            task: request.task,
            parentTool: request.parentTool,
        }, { propagate: true });
        try {
            if (request.role === 'mentor') {
                if (this.#mentorActive || this.#runtime.asyncRegistry.hasActiveRunForRole('mentor')) {
                    throw new SubagentRegistryError('already_active', 'Mentor session is already active');
                }
                this.#mentorActive = true;
            }
            const hasResolvedAgent = request.agentSpec !== undefined || request.resolvedDefinition !== undefined;
            const resolvedDefinition = hasResolvedAgent
                ? request.resolvedDefinition
                    ? { ...request.resolvedDefinition, isScriptGeneric: true }
                    : this.#resolveAgentSpec(request.agentSpec, request.executionBudget)
                : undefined;
            const result = hasResolvedAgent
                ? await this.#runtime.executionRunner.run(agentId, { ...request, role: 'agent', task: request.agentSpec?.goal ?? request.task, resolvedDefinition }, resolvedDefinition)
                : request.role === 'mentor'
                    ? await this.#runtime.mentorRunner.run(agentId, request.task, request.signal, undefined, request.executionBudget)
                    : await this.#runtime.executionRunner.run(agentId, request, this.#resolveRoleDefinition(request.role));
            await safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result }, { propagate: true });
            return result;
        }
        catch (error) {
            this.#logger.error('Subagent run failed', {
                agentId,
                role: request.role,
                error: error?.message,
                stack: error instanceof Error ? error.stack : undefined,
            });
            const isAbort = isAbortLike(error?.message, error);
            const usage = normalizeAgentRunUsage(error?.state?.usage) ?? extractUsage(error);
            const result = {
                agentId,
                role: request.role,
                status: isAbort ? 'cancelled' : 'failed',
                finalText: '',
                filesChanged: [],
                toolsUsed: [],
                error: error?.message || String(error),
                ...(usage ? { usage } : {}),
            };
            await safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result }, { propagate: true });
            return result;
        }
        finally {
            if (request.role === 'mentor')
                this.#mentorActive = false;
        }
    }
    /**
     * Start an asynchronous subagent run.
     *
     * Delegates to the SubagentAsyncRegistry, which owns the live session and
     * run lifecycle. The returned handle exposes only the live-run contract.
     */
    startRunAsync(request) {
        if (request.role === 'mentor' && this.#mentorActive) {
            throw new SubagentRegistryError('already_active', 'Mentor session is already active');
        }
        if (request.agentSpec || request.resolvedDefinition) {
            const resolvedDefinition = request.resolvedDefinition
                ? { ...request.resolvedDefinition, isScriptGeneric: true }
                : this.#resolveAgentSpec(request.agentSpec, request.executionBudget);
            return this.#runtime.asyncRegistry.startRun({
                ...request,
                role: 'agent',
                task: request.agentSpec?.goal ?? request.task,
                resolvedDefinition,
            });
        }
        return this.#runtime.asyncRegistry.startRun(request);
    }
    /**
     * Transfer one live foreground nested run into the async registry. This is
     * a candidate lookup plus atomic registry adoption, never a restart.
     */
    moveForegroundSubagent(runId) {
        const candidate = this.#runtime.nestedRunner.getForegroundCandidate(runId);
        if (!candidate || candidate.lease.adopted || candidate.lease.settled)
            return undefined;
        // A transferred child can request another tool approval at any later
        // segment. Never detach foreground ownership unless the session has
        // already installed the queue/control sink that will own that pause.
        if (!this.#runtime.nestedRunner.hasBackgroundApprovalPauseSink())
            return undefined;
        return this.#runtime.asyncRegistry.adoptForegroundLease(candidate.lease, candidate);
    }
    listForegroundSubagentCandidates() {
        return this.#runtime.nestedRunner.listForegroundCandidates();
    }
    /**
     * Retrieve the result of a previously started asynchronous subagent run.
     */
    getRunResult(runId, signal) {
        return this.#runtime.asyncRegistry.getResult(runId, signal);
    }
    /**
     * Non-blocking progress snapshot for the peek (get_subagent_status) tool.
     * One run when `runId` is provided, all non-evicted runs otherwise. Never
     * awaits and never carries completion detail.
     */
    getRunStatus(runId) {
        return this.#runtime.asyncRegistry.getRunStatus(runId);
    }
    /** Queue parent steering or an ask_orchestrator answer without awaiting a run. */
    sendMessageToAsyncRun(params) {
        return this.#runtime.asyncRegistry.sendMessage(params.target, params.message, params.reply_to);
    }
    /** Request two-phase parent cancellation by canonical runId or active name. */
    cancelAsyncRun(target) {
        return this.#runtime.asyncRegistry.cancelRun(target);
    }
    abortAsyncRun(runId) {
        this.#runtime.asyncRegistry.abortRun(runId);
    }
    resetAsyncRuns() {
        this.#runtime.asyncRegistry.reset();
    }
    /** Cancel all live asynchronous runs for an explicit parent abort. */
    cancelAllAsyncRuns() {
        this.#runtime.asyncRegistry.cancelAllRuns();
    }
    dispose() {
        this.#runtime.asyncRegistry.dispose();
    }
    /** Cancellation plus adopted-lease settlement for session shutdown ordering. */
    disposeAsync() {
        return this.#runtime.asyncRegistry.disposeAndWaitForAdoptedLeases();
    }
}
//# sourceMappingURL=subagent-manager.js.map