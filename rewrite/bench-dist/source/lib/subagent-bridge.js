import { randomUUID } from 'node:crypto';
import { SubagentManager } from '../services/subagents/subagent-manager.js';
import { adaptLegacyDefinition } from '../services/agent-runtime/legacy-adapter.js';
import { createRootBudget } from '../services/agent-runtime/execution-budget.js';
import { createAbortError } from '../services/subagents/utils.js';
function isBoundaryResult(value) {
    return typeof value === 'object' && value !== null && 'ok' in value;
}
function toManagerDefinition(value) {
    // A legacy definition is already the manager's immutable launch contract.
    // Preserve its identity so host callers can verify that no second
    // resolution or widening occurred in the bridge.
    if (isLegacyDefinition(value))
        return value;
    const budget = createRootBudget({
        maxChildren: value.limits.maxChildren,
        maxDepth: value.limits.maxDepth,
        maxConcurrency: value.limits.maxConcurrency,
        maxTokens: value.limits.maxTokens,
    });
    return {
        ...adaptLegacyDefinition(value, budget),
        isRootExecution: true,
    };
}
function isLegacyDefinition(value) {
    return typeof value.model === 'string';
}
function normalizeResolvedLaunch(params) {
    let definitionInput = params.resolvedDefinition;
    let task = params.task;
    let worktree = params.worktree;
    let authorizedWorktreePath = params.authorizedWorktreePath;
    if (isBoundaryResult(definitionInput)) {
        if (!definitionInput.ok) {
            throw new Error(`Agent specification rejected: ${definitionInput.errors.map((error) => error.message).join('; ')}`);
        }
        const successfulResult = definitionInput;
        definitionInput = successfulResult.definition;
        task ??= successfulResult.spec.goal;
        worktree ??= successfulResult.worktree;
        authorizedWorktreePath ??= successfulResult.authorizedWorktreePath;
    }
    if (!task) {
        throw new Error('Resolved subagent launches require a non-empty task.');
    }
    return {
        definition: toManagerDefinition(definitionInput),
        task,
        ...(worktree ? { worktree } : {}),
        ...(authorizedWorktreePath ? { authorizedWorktreePath } : {}),
    };
}
export class SubagentBridge {
    #subagentManager;
    #isDisposed = false;
    #sessionContextService;
    #subagentEventSink = null;
    #backgroundEventSink = null;
    #backgroundRunIds = new Set();
    #activeSubagentsCount = 0;
    #bufferedEvents = [];
    #logger;
    /** Per-turn scope: foreground subagent work belonging to the running turn. */
    #abortController = new AbortController();
    /**
     * Conversation scope: background (async) runs outlive the turn that launched
     * them, so they must not share the per-turn controller.
     */
    #backgroundAbortController = new AbortController();
    constructor(deps) {
        this.#logger = deps.logger;
        this.#sessionContextService = deps.sessionContextService;
        if (deps.subagentManager !== undefined) {
            this.#subagentManager = deps.subagentManager;
        }
        else {
            this.#subagentManager = new SubagentManager({
                driverFactory: deps.driverFactory,
                modelBinding: deps.modelBinding,
                logger: deps.logger,
                settings: deps.settings,
                executionContext: deps.executionContext,
                sessionContextService: deps.sessionContextService,
                onEvent: (event) => this.#emitEvent(event),
                agentClient: { chat: (message, options) => deps.chat(message, options) },
                createClient: deps.createClient,
                skillsService: deps.skillsService,
                toolOwnership: deps.toolOwnership,
                readOnly: deps.readOnly,
                scopedSandbox: deps.scopedSandbox,
                ...(deps.sessionBrowser ? { sessionBrowser: deps.sessionBrowser } : {}),
                ...(deps.backgroundApprovalPauseSink ? { backgroundApprovalPauseSink: deps.backgroundApprovalPauseSink } : {}),
            });
        }
    }
    async setEventSink(sink) {
        this.#subagentEventSink = sink;
        if (sink)
            await this.#flushBufferedEvents('foreground', sink);
    }
    /**
     * Conversation-scoped sink that outlives individual turns. Unlike
     * {@link setEventSink}, it is never torn down at turn end, so subagent
     * activity that settles while the conversation is idle is still observed
     * instead of being buffered until the next turn attaches a sink.
     */
    async setBackgroundEventSink(sink) {
        this.#backgroundEventSink = sink;
        if (sink)
            await this.#flushBufferedEvents('background', sink);
    }
    /** Installs the session-owned adopted-subagent approval pause sink. */
    setBackgroundApprovalPauseSink(sink) {
        this.#subagentManager?.setBackgroundApprovalPauseSink(sink ?? undefined);
    }
    answerBackgroundSubagentQuestion(runId, messageId, answer) {
        return (this.#subagentManager?.sendMessageToAsyncRun({ target: runId, message: answer, reply_to: messageId }).ok === true);
    }
    /** Exact nested-tool compatibility state from the manager's live runtime. */
    getNestedToolCompatibilityState() {
        return this.#subagentManager?.getNestedToolCompatibilityState();
    }
    /** End session-scoped subagent work and release its event sinks and caches. */
    dispose() {
        if (this.#isDisposed)
            return;
        this.#isDisposed = true;
        this.#abortController.abort();
        this.#backgroundAbortController.abort();
        this.#subagentManager?.cancelAllAsyncRuns();
        this.#subagentManager?.clearCache();
        this.#subagentManager?.resetMentorSession();
        this.#subagentManager?.dispose();
        this.#subagentManager = null;
        this.#subagentEventSink = null;
        this.#backgroundEventSink = null;
        this.#backgroundRunIds.clear();
        this.#bufferedEvents = [];
    }
    /**
     * Cancels and awaits adopted foreground leases without detaching either
     * event sink. The caller controls sink teardown after this promise settles.
     */
    disposeBackgroundSubagents() {
        return this.#subagentManager?.disposeAsync() ?? Promise.resolve();
    }
    async #flushBufferedEvents(scope, sink) {
        const pending = [];
        for (const buffered of this.#bufferedEvents) {
            if (buffered.scope === scope) {
                await sink(buffered.event);
            }
            else {
                pending.push(buffered);
            }
        }
        this.#bufferedEvents = pending;
    }
    async #emitEvent(event) {
        if (this.#isDisposed)
            return;
        const agentId = event.type === 'subagent_completed'
            ? event.result.agentId
            : 'agentId' in event && typeof event.agentId === 'string'
                ? event.agentId
                : undefined;
        const explicitlyAsync = 'async' in event && event.async === true;
        if (event.type === 'subagent_started' && explicitlyAsync && agentId) {
            this.#backgroundRunIds.add(agentId);
        }
        // Budget/stall judgement is parent-facing even for a foreground nested
        // child. Reuse the durable notification lane rather than making its
        // delivery depend on the parent tool call still owning an active UI sink.
        const scope = event.type === 'subagent_run_budget' ||
            explicitlyAsync ||
            (agentId !== undefined && this.#backgroundRunIds.has(agentId))
            ? 'background'
            : 'foreground';
        const sink = scope === 'background' ? this.#backgroundEventSink : this.#subagentEventSink;
        if (sink) {
            await sink(event);
        }
        else {
            this.#bufferedEvents.push({ event, scope });
        }
        if (scope === 'background' && event.type === 'subagent_completed' && agentId) {
            this.#backgroundRunIds.delete(agentId);
        }
    }
    /**
     * Obtain an AgentRuntime backed by this bridge's SubagentManager.
     * This is the stable production boundary for creating and running
     * one-shot agents through the same infrastructure that powers
     * subagent tool calls. Budget creation, scope enforcement, and
     * permission attenuation are all enforced.
     */
    getAgentRuntime() {
        return this.#subagentManager?.getAgentRuntime() ?? null;
    }
    clearSubagentCache() {
        if (this.#subagentManager) {
            this.#subagentManager.resetMentorSession();
        }
    }
    clearCache() {
        this.#subagentManager?.clearCache();
    }
    get activeSubagentsCount() {
        return this.#activeSubagentsCount;
    }
    /** Abort signal shared by the foreground subagent runs of the current turn. */
    get signal() {
        return this.#abortController.signal;
    }
    /**
     * Conversation-scoped abort signal for background (async) runs. It is never
     * reset or aborted by turn boundaries, only by {@link cancelBackgroundRuns}.
     */
    get backgroundSignal() {
        return this.#backgroundAbortController.signal;
    }
    /** Replace the per-turn abort controller so a new parent run starts fresh. */
    resetAbortController() {
        this.#abortController = new AbortController();
    }
    /**
     * Abort the foreground subagent runs of the current turn and prepare a fresh
     * controller. Background runs are conversation-bound and are deliberately
     * left alone; use {@link cancelBackgroundRuns} for those.
     */
    abort() {
        this.#abortController.abort();
        this.#abortController = new AbortController();
    }
    /**
     * Cancel every conversation-bound background run. Reserved for an explicit
     * user interrupt, conversation disposal, or shutdown.
     */
    cancelBackgroundRuns() {
        this.#backgroundAbortController.abort();
        this.#subagentManager?.cancelAllAsyncRuns();
        this.#backgroundAbortController = new AbortController();
    }
    /** Increment active count and return a disposer that decrements it */
    #beginSubagentRun() {
        this.#activeSubagentsCount++;
        return () => {
            this.#activeSubagentsCount--;
        };
    }
    /**
     * Runs `fn` under a traffic context whose provider history key identifies the
     * subagent run rather than the conversation that launched it. Providers key
     * server-side state off this — an OpenCode session, a Codex response chain —
     * so a run that reuses the parent's key writes its turns into the parent's
     * history.
     *
     * `runScope` identifies the run: a tool call ID, or `mentor` for the mentor
     * session that persists across consultations. It is appended to the current
     * key so a nested subagent scopes under its parent rather than flattening
     * back onto the conversation. Without one, a random scope is used: a fresh,
     * unshared history is a safer default than silently sharing the parent's.
     */
    #withSubagentTrafficContext(runScope, fn) {
        const currentContext = this.#sessionContextService.getContext();
        if (!currentContext) {
            return fn();
        }
        const parentKey = currentContext.providerHistoryKey ?? currentContext.sessionId;
        const scope = runScope ?? randomUUID();
        return this.#sessionContextService.runWithContext({ ...currentContext, providerHistoryKey: `${parentKey}:subagent:${scope}` }, fn);
    }
    createMentor = async (question) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot spawn subagents.');
        }
        const endRun = this.#beginSubagentRun();
        try {
            // The mentor session outlives a single consultation (see
            // `resetMentorSession`), so its scope is the role, not the call.
            const result = await this.#withSubagentTrafficContext('mentor', () => this.#subagentManager.run({
                role: 'mentor',
                task: question,
                parentTool: 'ask_mentor',
                signal: this.signal,
            }));
            if (result.status === 'failed') {
                throw new Error(result.error || 'Mentor consultation failed');
            }
            if (result.status === 'cancelled') {
                throw createAbortError('The mentor consultation was aborted.');
            }
            return result.finalText;
        }
        catch (error) {
            this.#logger.error('Mentor consultation failed', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        }
        finally {
            endRun();
        }
    };
    /**
     * Run a host-resolved generic agent through the normal foreground tool
     * lifecycle. The definition is deliberately handed to SubagentManager as
     * `resolvedDefinition`; the manager therefore skips raw AgentSpec
     * resolution while retaining nested approvals, the turn signal, worktree
     * pinning, and traffic scoping.
     */
    runResolvedSubagent = async (params, _context, details) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot spawn subagents.');
        }
        const launch = normalizeResolvedLaunch(params);
        const detailsRecord = details;
        const request = {
            role: 'agent',
            task: launch.task,
            resolvedDefinition: launch.definition,
            ...(launch.worktree ? { worktree: launch.worktree } : {}),
            ...(launch.authorizedWorktreePath ? { authorizedWorktreePath: launch.authorizedWorktreePath } : {}),
            parentTool: 'run_subagent',
            ...(detailsRecord?.resumeState ? { resumeState: detailsRecord.resumeState } : {}),
            signal: this.signal,
        };
        const endRun = this.#beginSubagentRun();
        try {
            return await this.#withSubagentTrafficContext(detailsRecord?.toolCall?.callId, () => this.#subagentManager.runAsTool(request, _context, params.foregroundChildApproval
                ? { ...detailsRecord, foregroundChildApproval: params.foregroundChildApproval }
                : details));
        }
        finally {
            endRun();
        }
    };
    /**
     * Start a host-resolved generic agent in the conversation-scoped async
     * registry. Unlike the foreground method, this uses `backgroundSignal`, so
     * an ordinary turn abort cannot cancel the retained run.
     */
    runResolvedSubagentAsync = async (params) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot spawn subagents.');
        }
        const launch = normalizeResolvedLaunch(params);
        const request = {
            role: 'agent',
            task: launch.task,
            resolvedDefinition: launch.definition,
            ...(params.name ? { name: params.name } : {}),
            ...(params.continue_run_id ? { continueRunId: params.continue_run_id } : {}),
            ...(launch.worktree ? { worktree: launch.worktree } : {}),
            ...(launch.authorizedWorktreePath ? { authorizedWorktreePath: launch.authorizedWorktreePath } : {}),
            parentTool: 'run_subagent',
            signal: this.backgroundSignal,
        };
        return this.#subagentManager.startRunAsync(request);
    };
    runSubagent = async (params, _context, details) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot spawn subagents.');
        }
        const detailsRecord = details;
        const request = {
            role: params.agent_spec ? 'agent' : params.role,
            task: params.agent_spec?.goal ?? params.task,
            ...(params.agent_spec ? { agentSpec: params.agent_spec } : {}),
            ...(params.worktree ? { worktree: params.worktree } : {}),
            parentTool: 'run_subagent',
            ...(detailsRecord?.resumeState ? { resumeState: detailsRecord.resumeState } : {}),
            signal: this.signal,
        };
        const endRun = this.#beginSubagentRun();
        try {
            return await this.#withSubagentTrafficContext(detailsRecord?.toolCall?.callId, () => this.#subagentManager.runAsTool(request, _context, details));
        }
        finally {
            endRun();
        }
    };
    runSubagentAsync = async (params, _context, _details) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot spawn subagents.');
        }
        const request = {
            role: params.agent_spec ? 'agent' : params.role,
            task: params.agent_spec?.goal ?? params.task,
            ...(params.agent_spec ? { agentSpec: params.agent_spec } : {}),
            ...(params.name ? { name: params.name } : {}),
            ...(params.continue_run_id ? { continueRunId: params.continue_run_id } : {}),
            ...(params.worktree ? { worktree: params.worktree } : {}),
            parentTool: 'run_subagent',
            // Conversation-scoped, not per-turn: this run must survive the turn that
            // launched it and every ordinary abort.
            signal: this.backgroundSignal,
        };
        // Deliberately not scoped here: a background run outlives the tool call that
        // launched it and can be continued from a later one, so only the registry —
        // which owns the run ID — can give every segment one stable scope. See
        // `SubagentAsyncRegistry`'s `trafficContext`.
        return this.#subagentManager.startRunAsync(request);
    };
    getSubagentResult = async (params, _context, details) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot spawn subagents.');
        }
        const detailsRecord = details;
        return this.#subagentManager.getRunResult(params.runId, detailsRecord?.signal);
    };
    /**
     * Non-blocking peek: progress snapshot for one run (runId provided) or all
     * non-evicted runs (runId omitted). Never awaits; never carries completion
     * detail. Throws only when the bridge has no manager (transient clients).
     */
    getSubagentStatus = (params, _context, _details) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot get subagent status.');
        }
        return this.#subagentManager.getRunStatus(params.runId);
    };
    /** Root-session control seam for one background run's live or retained status. */
    getBackgroundSubagentStatus(runId) {
        return this.getSubagentStatus({ runId });
    }
    /** Root-session control seam listing registry-retained runs, live entries first. */
    listBackgroundSubagentStatuses() {
        return this.getSubagentStatus({});
    }
    /** Parent-only non-blocking control for active async execution runs. */
    sendSubagentMessage = (params) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot control asynchronous subagents.');
        }
        return this.#subagentManager.sendMessageToAsyncRun(params);
    };
    /** Parent-only non-blocking two-phase cancellation by runId or active name. */
    cancelSubagentRun = (params) => {
        if (!this.#subagentManager) {
            throw new Error('Transient agent clients cannot control asynchronous subagents.');
        }
        return this.#subagentManager.cancelAsyncRun(params.target);
    };
    /** Root-session control seam for stopping one canonical background run id. */
    requestBackgroundSubagentStop(runId) {
        return this.cancelSubagentRun({ target: runId });
    }
    /**
     * Minimal session-control seam for a later task manager. Successful moves
     * switch event routing through the registry's async started event; no UI or
     * approval policy is coupled here.
     */
    moveForegroundSubagent(runId) {
        if (!this.#subagentManager)
            throw new Error('Transient agent clients cannot move subagents.');
        return this.#subagentManager.moveForegroundSubagent(runId);
    }
    /** Observational candidates for foreground-to-background transfer controls. */
    listForegroundSubagentCandidates() {
        return this.#subagentManager?.listForegroundSubagentCandidates() ?? [];
    }
    abortAsyncRun = (runId) => {
        this.#subagentManager?.abortAsyncRun(runId);
    };
    resetAsyncRuns = () => {
        this.#subagentManager?.resetAsyncRuns();
    };
    /** @deprecated Ordinary turns do not cancel async runs. */
    cancelAsyncRuns = () => {
        // Kept for callers compiled against the Phase 1 bridge.
    };
}
//# sourceMappingURL=subagent-bridge.js.map