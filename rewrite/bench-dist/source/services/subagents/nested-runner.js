import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApprovalLedger } from '../agent-runtime/tool-invocation-context.js';
import { getProvider } from '../../providers/index.js';
import { isTerminalSubagentResult } from './types.js';
import { clampRunBudgetPolicy, readRunBudgetPolicy } from '../agent-runtime/run-budget.js';
import { SUBAGENT_ROLES } from './types.js';
import { getSubagentRunContext } from './tool-policy.js';
import { loadRoleDefinition, resolveSubagentSearchViaShell, buildInstructions } from './role-loader.js';
import { SubagentRolePoolSelector } from './subagent-role-pool-selector.js';
import { extractFinalText, extractPartialToolEvidence, aggregateContextToolUsage, safeEmit, createCompositeAbortSignal, createAbortError, isAbortLike, isMaxTurnsExceededError, extractMaxTurnsLimit, buildTurnBudgetExhaustedFinalText, } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import { replayApprovals } from '../approval/approval-replay.js';
import { AcquiredChildSlot } from '../agent-runtime/execution-budget.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { normalizeToolParameters } from '../../lib/tool-invoke.js';
import { ForegroundSubagentLease, } from './foreground-subagent-lease.js';
import { pinWorkerWorktree } from './worker-worktree.js';
import { classifyPoolEntryFailure } from '../retry/provider-failure-classification.js';
import { streamHasCommittedOutput } from '../agent-stream.js';
const AGENT_TOOL_ERROR_PREFIX = 'An error occurred while running the tool. Please try again. Error:';
// Turn counting used to live here as a `callModelInputFilter` hook, which the
// SDK-shaped tool wrapper dropped on the floor. `ApplicationRunLoop` owns it
// now: the nested run is given `maxTurns` and reports its budget to tools as
// `ToolInvocationContext.turn`.
function collectApprovalCallIds(interruptions) {
    if (!Array.isArray(interruptions)) {
        return [];
    }
    const callIds = [];
    for (const interruption of interruptions) {
        const callId = getCallIdFromObject(interruption);
        if (callId) {
            callIds.push(callId);
        }
    }
    return callIds;
}
/**
 * Reads the approvals of the run context the subagent tool was invoked from.
 *
 * The parent is the `ToolInvocationContext` the run loop hands to tools; its
 * ledger snapshot replaces the old structural `toJSON()` probe on whatever the
 * loop handed over (which was never a RunContext, so replay was always a no-op
 * — F5). A caller without a ledger simply contributes no approvals.
 */
function readParentApprovals(context) {
    const parent = context;
    return parent?.approvals?.snapshot();
}
function parseNestedSubagentResult(raw) {
    const output = String(raw);
    if (output.startsWith(AGENT_TOOL_ERROR_PREFIX)) {
        const message = output.slice(AGENT_TOOL_ERROR_PREFIX.length).trim();
        throw new Error(message || 'Nested subagent tool failed');
    }
    return JSON.parse(output);
}
export class NestedSubagentRunner {
    #driverFactory;
    #modelBinding;
    #logger;
    #settings;
    #sessionContextService;
    #executionContext;
    #toolFactory;
    #onEvent;
    #roleToolCache;
    #rolePoolSelector;
    #skillsService;
    #toolOwnership;
    /** Live foreground runs, addressable by the stable root tool-call id. */
    #foregroundLeases = new Map();
    /** Session-owned publication path for pauses after a foreground run moves. */
    #backgroundApprovalPauseSink;
    /**
     * Optional resolver that overrides the default `loadRoleDefinition`.
     * When set, all role loads in `#getOrCreateRoleTool` go through this
     * callback. This allows the agent-runtime / `SubagentManager` to
     * inject the shared `ResolvedAgentDefinition` adaptation so that every
     * role passes through the same resolution before reaching the SDK.
     */
    #resolveRole;
    constructor(deps) {
        this.#driverFactory = deps.driverFactory;
        this.#modelBinding = deps.modelBinding;
        this.#logger = deps.logger;
        this.#settings = deps.settings;
        this.#sessionContextService = deps.sessionContextService;
        this.#executionContext = deps.executionContext;
        this.#toolFactory = deps.toolFactory;
        this.#onEvent = deps.onEvent;
        this.#roleToolCache = deps.roleToolCache;
        this.#resolveRole = deps.resolveRole;
        this.#skillsService = deps.skillsService;
        this.#toolOwnership = deps.toolOwnership;
        this.#backgroundApprovalPauseSink = deps.backgroundApprovalPauseSink;
        this.#rolePoolSelector = deps.rolePoolSelector ?? new SubagentRolePoolSelector(deps.settings);
    }
    clearCache() {
        this.#roleToolCache.clear();
    }
    getRoleAgentTool(role) {
        return this.#getOrCreateRoleTool(role).tool;
    }
    getRoleAgent(role) {
        return this.#getOrCreateRoleTool(role).agent;
    }
    /** Candidate lookup only; ownership moves through the async registry. */
    getForegroundLease(runId) {
        return this.#foregroundLeases.get(runId)?.lease;
    }
    getForegroundCandidate(runId) {
        return this.#foregroundLeases.get(runId);
    }
    /** Observational projection; the lease itself remains runner-owned. */
    listForegroundCandidates() {
        return [...this.#foregroundLeases.values()]
            .filter(({ lease }) => !lease.adopted && !lease.settled)
            .map(({ lease: _lease, ...candidate }) => candidate);
    }
    /** Replaces the session-owned pause publication sink without rebuilding role tools. */
    setBackgroundApprovalPauseSink(sink) {
        this.#backgroundApprovalPauseSink = sink;
    }
    /** A move is unsafe unless a later child-tool pause has a session owner. */
    hasBackgroundApprovalPauseSink() {
        return this.#backgroundApprovalPauseSink !== undefined;
    }
    #restoreRunContext(resumeState) {
        if (!resumeState)
            return undefined;
        try {
            const parsed = JSON.parse(resumeState);
            const context = parsed?.context?.context;
            if (context &&
                typeof context.agentId === 'string' &&
                Array.isArray(context.filesChanged) &&
                context.toolCounts &&
                typeof context.toolCounts === 'object' &&
                context.activeCommandMessages &&
                typeof context.activeCommandMessages === 'object') {
                return context;
            }
        }
        catch (error) {
            this.#logger.warn('Failed to restore nested subagent bookkeeping context', {
                error: error?.message || String(error),
            });
        }
        return undefined;
    }
    #getOrCreateRoleTool(role) {
        const cached = this.#roleToolCache.get(role);
        if (cached)
            return cached;
        const created = this.#buildRoleTool(role);
        this.#roleToolCache.set(role, created);
        return created;
    }
    /**
     * Resolves the role tool for one foreground spawn (one `runAsTool` call).
     * The role cache pins whichever model built its cached tool for the life
     * of the session, so a configured pool bypasses the cache entirely and
     * builds a fresh tool per spawn — the same ephemeral-build path the
     * worktree pin already uses — advancing the pool's round-robin cursor
     * exactly once for this call.
     */
    #resolveRoleToolForSpawn(role) {
        if (!this.#rolePoolSelector.hasPool(role))
            return this.#getOrCreateRoleTool(role);
        return this.#buildRoleTool(role, { applyPool: true });
    }
    /**
     * Builds role tools for one nested run. When `executionContext` is supplied
     * (worker worktree pin), tools are ephemeral and must not enter the role
     * cache — that cache freezes the session root. `applyPool` runs this
     * spawn's role definition through the round-robin pool selector; only set
     * it from a call site that builds exactly once per spawn (never from a
     * cached path), or the cursor advances more than once for one spawn.
     */
    #buildRoleTool(role, options) {
        // Use the injected resolver when available (shared ResolvedAgentDefinition
        // adaptation path); otherwise fall back to direct loadRoleDefinition.
        let definition = this.#resolveRole ? this.#resolveRole(role) : loadRoleDefinition(role, this.#settings);
        if (options?.applyPool) {
            definition = this.#rolePoolSelector.resolveForSpawn(role, definition);
        }
        return this.#buildDefinitionTool(definition, role, options);
    }
    #buildDefinitionTool(definition, role, options) {
        const searchViaShell = resolveSubagentSearchViaShell(this.#settings, definition.canRunShell);
        const runExecutionContext = options?.executionContext ?? this.#executionContext;
        const toolDefinitions = this.#toolFactory.buildToolDefinitions(definition, [], '', searchViaShell, true, undefined, undefined, undefined, options?.executionContext ? { executionContext: options.executionContext } : undefined);
        const providerId = definition.provider;
        const tools = this.#toolFactory.buildAgentTools(toolDefinitions, {
            providerId,
            onToolStart: (name, params, commandMessages, context, details) => {
                const runContext = getSubagentRunContext(context);
                if (!runContext)
                    return;
                const callId = details?.toolCall?.callId ?? `subagent-tool-${randomUUID()}`;
                runContext.toolCounts[name] = (runContext.toolCounts[name] ?? 0) + 1;
                runContext.activeCommandMessages[callId] = commandMessages;
                safeEmit(this.#logger, this.#onEvent, {
                    type: 'subagent_tool_started',
                    agentId: runContext.agentId,
                    role: runContext.role,
                    toolCallId: callId,
                    toolName: name,
                    arguments: params,
                });
                for (const message of commandMessages) {
                    safeEmit(this.#logger, this.#onEvent, {
                        type: 'subagent_command_message',
                        agentId: runContext.agentId,
                        role: runContext.role,
                        message,
                    });
                }
            },
            onToolComplete: (_name, result, context, details) => {
                const runContext = getSubagentRunContext(context);
                if (!runContext)
                    return;
                const callId = details?.toolCall?.callId;
                const messages = (callId && runContext.activeCommandMessages[callId]) ?? [];
                for (const message of messages) {
                    safeEmit(this.#logger, this.#onEvent, {
                        type: 'subagent_command_message',
                        agentId: runContext.agentId,
                        role: runContext.role,
                        message: {
                            ...message,
                            status: 'completed',
                            output: typeof result === 'string' ? result : JSON.stringify(result),
                            success: true,
                        },
                    });
                }
                if (callId) {
                    delete runContext.activeCommandMessages[callId];
                }
            },
        });
        const modelSettings = {
            retry: { maxRetries: this.#settings.get('agent.retryAttempts') ?? 2 },
        };
        if (definition.reasoningEffort && definition.reasoningEffort !== 'default') {
            modelSettings.reasoning = { effort: definition.reasoningEffort, summary: 'auto' };
        }
        // Pass maxTokens from definition to provider model settings
        if (definition.maxTokens !== undefined) {
            modelSettings.maxTokens = definition.maxTokens;
        }
        const instructions = buildInstructions(definition, toolDefinitions, searchViaShell, this.#settings, runExecutionContext, this.#skillsService);
        const agent = {
            name: definition.name,
            model: definition.model,
            modelSettings,
            instructions,
            tools,
        };
        const tool = this.createSubagentTool(role, definition, agent);
        return {
            agent,
            tool,
            model: { provider: definition.provider, id: definition.model },
            maxTurns: definition.maxTurns,
        };
    }
    /**
     * Builds the `run_subagent_<role>` tool. Its `execute` actually runs the role
     * agent through `ApplicationRunLoop` — replacing the legacy `Agent.asTool`
     * stub whose execute returned the raw task string and dropped every run
     * option, which is why nested subagents could never return a result (F1).
     *
     * The run's `SubagentRunContext` and the replayed parent approvals arrive on
     * the `ToolInvocationContext` that `runAsTool` builds; the loop seeds its
     * ledger from `toolContext.approvals`, so parent decisions are honored (F5)
     * and the run's own decisions accumulate on the same ledger.
     */
    createSubagentTool(role, definition, agent) {
        const parameters = z.object({
            role: z.literal(role),
            task: z.string(),
        });
        return {
            name: `run_subagent_${role}`,
            description: `Run the ${role} subagent.`,
            parameters,
            needsApproval: () => false,
            formatCommandMessage: () => [],
            execute: async (params, context, details) => {
                const { task } = params;
                const toolContext = context;
                const runContext = toolContext?.context ??
                    {
                        agentId: randomUUID(),
                        role,
                        task,
                        filesChanged: [],
                        toolCounts: {},
                        activeCommandMessages: {},
                        turnCount: 0,
                        maxTurns: definition.maxTurns,
                    };
                runContext.task = task;
                const detailsRecord = details;
                const foregroundLease = detailsRecord?.foregroundSubagentLease;
                const signal = detailsRecord?.signal;
                const providerId = definition.provider;
                const provider = this.#modelBinding
                    ? this.#modelBinding.providerDefinition(providerId)
                    : getProvider(providerId);
                if (!provider?.createStreamedModel) {
                    throw new Error(`Provider '${providerId}' has no application-owned model for nested subagents`);
                }
                const createStreamedModel = provider.createStreamedModel;
                // Continuations can be triggered later from the session's background
                // control lane. Preserve the provider-history context captured at
                // launch instead of inheriting that unrelated caller context.
                const trafficContext = this.#sessionContextService.getContext();
                const factory = this.#driverFactory;
                if (!factory)
                    throw new Error('Missing nested run driver');
                const loop = factory({
                    resolveMaxParallelToolCalls: () => this.#settings.get('agent.maxParallelToolCalls'),
                    resolveModel: (model) => this.#modelBinding
                        ? this.#modelBinding.scopedModel({ provider: providerId, model }, {
                            settingsService: this.#settings,
                            loggingService: this.#logger,
                            sessionContextService: this.#sessionContextService,
                        })
                        : createStreamedModel(model, {
                            settingsService: this.#settings,
                            loggingService: this.#logger,
                            sessionContextService: this.#sessionContextService,
                        }),
                });
                let stream = loop.startStream(agent, task, {
                    context: runContext,
                    signal,
                    providerId,
                    supportsConversationChaining: provider.capabilities?.supportsConversationChaining === true,
                    // The nested run's ledger was seeded with the parent's decisions by
                    // runAsTool; use it so F5 holds and nested decisions land on it.
                    approvals: toolContext?.approvals,
                    // Without this the role's configured budget is advisory only and the
                    // nested run is bounded solely by the model choosing to stop.
                    maxTurns: definition.maxTurns,
                    runBudget: clampRunBudgetPolicy(readRunBudgetPolicy(this.#settings), toolContext?.budget?.remainingPolicy()),
                    wrapUpOnCriticalRunBudget: true,
                    onRunBudgetEvent: (event) => safeEmit(this.#logger, this.#onEvent, {
                        type: 'subagent_run_budget',
                        agentId: runContext.agentId,
                        role,
                        event,
                    }),
                });
                let settled;
                let terminalCause;
                // A transferred run never manufactures a second execution. Each
                // continuation resolves exactly one tool interruption, then this loop
                // observes the next returned segment (including batched siblings).
                try {
                    for (;;) {
                        settled = await stream.completed;
                        terminalCause = stream.terminalCause;
                        this.#toolOwnership.claim(collectApprovalCallIds(stream.interruptions), {
                            kind: 'subagent',
                            agentId: runContext.agentId,
                            role,
                        });
                        if (!stream.interruptions?.length || !stream.state)
                            break;
                        let resumed;
                        const continueOriginalStream = () => {
                            resumed = trafficContext
                                ? this.#sessionContextService.runWithContext(trafficContext, () => loop.continueRunStream(stream.state))
                                : loop.continueRunStream(stream.state);
                        };
                        const continued = foregroundLease?.adopted
                            ? await foregroundLease.waitForBackgroundContinuation(stream.state, stream.interruptions[0], continueOriginalStream, (snapshot) => {
                                this.#onEvent?.({
                                    type: 'subagent_approval_required',
                                    agentId: runContext.agentId,
                                    role,
                                });
                                this.#backgroundApprovalPauseSink?.({
                                    ...snapshot,
                                    role,
                                    apply: (callback) => foregroundLease.applyBackgroundApproval(snapshot, callback),
                                });
                            })
                            : foregroundLease && detailsRecord?.foregroundChildApproval
                                ? await foregroundLease.waitForForegroundContinuation(stream.state, stream.interruptions[0], continueOriginalStream, (_snapshot) => {
                                    this.#onEvent?.({
                                        type: 'subagent_approval_required',
                                        agentId: runContext.agentId,
                                        role,
                                    });
                                }, (snapshot) => detailsRecord.foregroundChildApproval({
                                    ...snapshot,
                                    role,
                                    apply: (callback) => foregroundLease.applyForegroundApproval(snapshot, callback),
                                }))
                                : false;
                        if (!continued || !resumed)
                            break;
                        stream = resumed;
                    }
                }
                catch (error) {
                    // Turn-budget exhaustion is a containment stop: settle a completed
                    // report with partial side effects rather than failing the parent tool.
                    if (isMaxTurnsExceededError(error) && signal?.aborted !== true) {
                        const maxTurns = extractMaxTurnsLimit(error) ?? definition.maxTurns;
                        this.#logger.warn('Subagent turn budget exhausted', {
                            agentId: runContext.agentId,
                            role,
                            maxTurns,
                        });
                        const budgetResult = {
                            agentId: runContext.agentId,
                            role,
                            status: 'interrupted',
                            terminalCause: 'budget_exhausted',
                            finalText: buildTurnBudgetExhaustedFinalText({
                                maxTurns,
                                partialText: extractFinalText(stream),
                            }),
                            filesChanged: [...new Set(runContext.filesChanged)],
                            toolsUsed: aggregateContextToolUsage(runContext.toolCounts),
                            usage: extractUsage(stream),
                            costRecords: stream.runCostRecords,
                        };
                        return JSON.stringify(budgetResult);
                    }
                    // If the subagent executed tools before encountering an unrecoverable failure
                    // (e.g. fatal transport drop after retries exhausted), contain the failure into
                    // a structured failed result with partial findings so the parent agent receives
                    // the collected evidence and does not lose all progress.
                    const toolCallCount = Object.values(runContext.toolCounts).reduce((total, count) => total + count, 0);
                    if (toolCallCount > 0 && signal?.aborted !== true) {
                        const errorMessage = error?.message || String(error);
                        this.#logger.warn('Subagent failed after tool executions; returning containment result', {
                            agentId: runContext.agentId,
                            role,
                            error: errorMessage,
                            toolCallCount,
                        });
                        const partialText = extractFinalText(stream);
                        const partialToolEvidence = await extractPartialToolEvidence(stream);
                        const preservedProgress = [partialText, partialToolEvidence].filter(Boolean).join('\n\n');
                        const failureResult = {
                            agentId: runContext.agentId,
                            role,
                            status: 'failed',
                            error: errorMessage,
                            finalText: preservedProgress
                                ? `${preservedProgress}\n\n[Subagent stopped due to error: ${errorMessage}]`
                                : `[Subagent stopped due to error after ${toolCallCount} tool action(s): ${errorMessage}]`,
                            filesChanged: [...new Set(runContext.filesChanged)],
                            toolsUsed: aggregateContextToolUsage(runContext.toolCounts),
                            usage: extractUsage(stream),
                            costRecords: stream.runCostRecords,
                        };
                        return JSON.stringify(failureResult);
                    }
                    if (error && typeof error === 'object' && !streamHasCommittedOutput(stream) && toolCallCount === 0) {
                        error.poolFailoverSafe = true;
                    }
                    throw error;
                }
                const interrupted = Boolean(stream.interruptions?.length);
                const cancelled = signal?.aborted === true;
                const result = {
                    agentId: runContext.agentId,
                    role,
                    // An interrupted run stopped at an approval pause with work still
                    // pending; reporting it as completed told the parent model the
                    // opposite of what the event stream said.
                    status: cancelled ? 'cancelled' : interrupted ? 'interrupted' : terminalCause ? 'interrupted' : 'completed',
                    finalText: extractFinalText(stream),
                    filesChanged: [...new Set(runContext.filesChanged)],
                    toolsUsed: aggregateContextToolUsage(runContext.toolCounts),
                    usage: normalizeAgentRunUsage(settled?.usage) ?? extractUsage(stream),
                    costRecords: stream.runCostRecords,
                    ...(interrupted && !cancelled ? { interrupted: true } : {}),
                    ...(terminalCause ? { terminalCause } : {}),
                };
                return JSON.stringify(result);
            },
        };
    }
    async runAsTool(request, context, details) {
        const generic = request.resolvedDefinition !== undefined;
        if (!generic && !SUBAGENT_ROLES.includes(request.role)) {
            throw new Error(`Unsupported subagent role: "${request.role}"`);
        }
        const role = request.role;
        const detailsRecord = details;
        let worktreePath;
        let pinnedRoleTool;
        let pinnedExecutionContext;
        if (request.worktree) {
            const pin = await pinWorkerWorktree({
                name: request.worktree,
                role: request.role,
                homeRoot: this.#executionContext?.getHomeWorkspace() ?? process.cwd(),
                isRemote: this.#executionContext?.isRemote() ?? false,
                authorizedPath: request.authorizedWorktreePath,
            });
            if (!pin.ok) {
                const agentId = detailsRecord?.toolCall?.callId ?? randomUUID();
                const failed = {
                    agentId,
                    role,
                    status: 'failed',
                    finalText: '',
                    filesChanged: [],
                    toolsUsed: [],
                    error: pin.error,
                };
                await safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: { ...failed, status: 'failed' } }, { propagate: true });
                return failed;
            }
            worktreePath = pin.worktreePath;
            pinnedExecutionContext = pin.executionContext;
            pinnedRoleTool = generic
                ? this.#buildDefinitionTool(request.resolvedDefinition, request.role, {
                    executionContext: pin.executionContext,
                })
                : this.#buildRoleTool(role, { executionContext: pin.executionContext, applyPool: true });
        }
        // ── Budget enforcement ──
        // Only acquire a slot for fresh runs, not resumed ones (resumed runs
        // already hold their slot from the initial invocation).
        let childSlot;
        if (request.executionBudget && !detailsRecord?.resumeState) {
            const slot = request.executionBudget.tryAcquireChild();
            if (!(slot instanceof AcquiredChildSlot)) {
                const rejection = slot;
                throw new Error(`Budget exhausted: ${rejection.reason}${rejection.max !== undefined ? ` (${rejection.current}/${rejection.max})` : ''}`);
            }
            childSlot = slot;
        }
        // The lease is created before any provider work starts. Its independent
        // controller keeps the child alive after a truthful transfer, while its
        // detachable parent link preserves ordinary foreground abort beforehand.
        const candidateRunId = detailsRecord?.toolCall?.callId ?? randomUUID();
        const parentComposite = createCompositeAbortSignal(detailsRecord?.signal, request.signal);
        // A `resumeState` call resumes a previously interrupted invocation of
        // this same tool call (SDK-level continuation), not a new spawn: it must
        // reuse whatever tool the original call resolved to rather than drawing
        // another pool entry, so it always takes the cache path.
        let roleTool = pinnedRoleTool ??
            (generic
                ? this.#buildDefinitionTool(request.resolvedDefinition, request.role)
                : detailsRecord?.resumeState
                    ? this.#getOrCreateRoleTool(role)
                    : this.#resolveRoleToolForSpawn(role));
        const lease = new ForegroundSubagentLease({
            runId: candidateRunId,
            parentSignal: parentComposite?.signal,
            model: roleTool.model,
            onPendingApprovalReleased: (interruption) => {
                const callId = getCallIdFromObject(interruption);
                if (callId)
                    this.#toolOwnership.release(callId);
            },
        });
        this.#foregroundLeases.set(candidateRunId, {
            lease,
            runId: candidateRunId,
            role,
            task: request.task,
            parentTool: request.parentTool,
            startedAt: Date.now(),
            model: roleTool.model,
        });
        const composite = createCompositeAbortSignal(lease.signal);
        const signal = composite?.signal;
        if (signal?.aborted) {
            childSlot?.release();
            throw createAbortError('The nested subagent run was aborted.');
        }
        const restoredContext = this.#restoreRunContext(detailsRecord?.resumeState);
        const agentId = restoredContext?.agentId ?? candidateRunId;
        const runContext = restoredContext ?? {
            agentId,
            role,
            task: request.task,
            filesChanged: [],
            toolCounts: {},
            activeCommandMessages: {},
            turnCount: 0,
            maxTurns: roleTool.maxTurns,
        };
        runContext.task = request.task;
        if (!detailsRecord?.resumeState) {
            await safeEmit(this.#logger, this.#onEvent, {
                type: 'subagent_started',
                agentId,
                role,
                task: request.task,
                parentTool: request.parentTool,
            }, { propagate: true });
        }
        const nestedLedger = new ApprovalLedger();
        // The subagent runs in its own ledger. The parent's blanket ("always") decisions
        // carry across; per-call decisions name the parent's calls and never authorize a
        // child call, even one whose provider-generated id happens to match.
        let abortListener;
        let transferredToBackground = false;
        try {
            replayApprovals(nestedLedger, readParentApprovals(context), roleTool.agent);
            const nestedToolContext = {
                context: runContext,
                approvals: nestedLedger,
                signal,
            };
            const effectiveDetails = { ...detailsRecord, ...(signal ? { signal } : {}), foregroundSubagentLease: lease };
            const abortPromise = signal
                ? new Promise((_, reject) => {
                    abortListener = () => reject(createAbortError('The nested subagent run was aborted.'));
                    signal.addEventListener('abort', abortListener, { once: true });
                })
                : null;
            const execution = (async () => {
                for (;;) {
                    try {
                        return await roleTool.tool.execute(normalizeToolParameters({ role, task: request.task }, roleTool.tool.parameters), nestedToolContext, effectiveDetails);
                    }
                    catch (error) {
                        const failure = classifyPoolEntryFailure(error);
                        if (generic ||
                            detailsRecord?.resumeState ||
                            !this.#rolePoolSelector.hasPool(role) ||
                            !failure ||
                            !error?.poolFailoverSafe ||
                            lease.adopted ||
                            signal?.aborted)
                            throw error;
                        const previous = roleTool.model;
                        this.#rolePoolSelector.markUnhealthy({ provider: previous.provider, model: previous.id }, failure);
                        roleTool = this.#buildRoleTool(role, {
                            ...(pinnedExecutionContext ? { executionContext: pinnedExecutionContext } : {}),
                            applyPool: true,
                        });
                        lease.setModel(roleTool.model);
                        const candidate = this.#foregroundLeases.get(candidateRunId);
                        if (candidate)
                            candidate.model = roleTool.model;
                        this.#logger.warn('Subagent pool failover', {
                            role,
                            from: `${previous.provider}/${previous.id}`,
                            failure,
                            to: `${roleTool.model.provider}/${roleTool.model.id}`,
                        });
                    }
                }
            })();
            const promises = [execution];
            if (abortPromise) {
                promises.push(abortPromise);
            }
            // Successful adoption resolves the foreground tool exactly once while
            // retaining the original promise (and therefore its budget slot) until
            // the actual child loop settles.
            const transferred = Symbol('foreground-subagent-transferred');
            promises.push(lease.waitForAdoption().then((adopted) => (adopted ? transferred : new Promise(() => { }))));
            const raw = await Promise.race(promises);
            if (raw === transferred) {
                transferredToBackground = true;
                const transferredSlot = childSlot;
                const emitTransferredFailure = (error) => {
                    // The foreground tool result has already been handed off. A late
                    // loop rejection or parse failure must therefore enter the durable
                    // async terminal lane; otherwise get_subagent_result hangs forever.
                    safeEmit(this.#logger, this.#onEvent, {
                        type: 'subagent_completed',
                        async: true,
                        result: {
                            agentId,
                            role,
                            status: lease.signal.aborted || isAbortLike(error?.message, error) ? 'cancelled' : 'failed',
                            finalText: '',
                            filesChanged: [],
                            toolsUsed: [],
                            error: error?.message || String(error),
                        },
                    });
                };
                void execution
                    .then((terminal) => {
                    try {
                        const parsed = parseNestedSubagentResult(terminal);
                        if (worktreePath) {
                            parsed.worktreePath = worktreePath;
                        }
                        if (transferredSlot && parsed.usage)
                            request.executionBudget.recordUsage(parsed.usage);
                        // Once adopted, the background continuation loop resolves
                        // every approval pause itself, so by the time `execution`
                        // settles here `interrupted` is always a terminal outcome
                        // (e.g. `budget_exhausted`), never a live pending pause. It
                        // must still reach the completed lane with full evidence, or
                        // a budget-contained background worker settles with nobody
                        // ever told — the async registry and get_subagent_result
                        // would see nothing and keep reporting it as still running.
                        if (isTerminalSubagentResult(parsed)) {
                            const completed = { ...parsed, status: parsed.status };
                            safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: completed, async: true });
                        }
                    }
                    catch (error) {
                        emitTransferredFailure(error);
                    }
                    lease.settle();
                }, (error) => {
                    emitTransferredFailure(error);
                    lease.settle();
                })
                    .finally(() => {
                    this.#foregroundLeases.delete(candidateRunId);
                    transferredSlot?.release();
                });
                childSlot = undefined;
                return {
                    agentId,
                    role,
                    status: 'running',
                    finalText: '',
                    filesChanged: [],
                    toolsUsed: [],
                    ...(worktreePath ? { worktreePath } : {}),
                };
            }
            const parsed = parseNestedSubagentResult(raw);
            if (worktreePath) {
                parsed.worktreePath = worktreePath;
            }
            // Record usage from nested run
            if (childSlot && parsed.usage) {
                request.executionBudget.recordUsage(parsed.usage);
            }
            // The parent model already receives the full result (evidence included)
            // as this tool call's return value below, regardless of which event
            // fires here. This event only drives the live foreground transcript
            // card. A live approval pause gets the lighter-weight
            // `subagent_interrupted` update; a caused interruption such as budget
            // exhaustion is terminal and must announce completion.
            if (isTerminalSubagentResult(parsed)) {
                const completed = { ...parsed, status: parsed.status };
                await safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: completed }, { propagate: true });
            }
            else if (parsed.status === 'interrupted') {
                await safeEmit(this.#logger, this.#onEvent, {
                    type: 'subagent_interrupted',
                    agentId: parsed.agentId,
                    role: parsed.role,
                    finalText: parsed.finalText,
                }, { propagate: true });
            }
            return parsed;
        }
        catch (error) {
            this.#logger.error('Nested subagent tool failed', {
                agentId,
                role,
                error: error?.message || String(error),
            });
            await safeEmit(this.#logger, this.#onEvent, {
                type: 'subagent_completed',
                result: {
                    agentId,
                    role,
                    status: isAbortLike(error?.message, error) ? 'cancelled' : 'failed',
                    finalText: '',
                    filesChanged: [],
                    toolsUsed: [],
                    error: error?.message || String(error),
                },
            }, { propagate: true });
            throw error;
        }
        finally {
            if (!transferredToBackground) {
                lease.settle();
                this.#foregroundLeases.delete(candidateRunId);
                childSlot?.release();
            }
            if (abortListener && signal) {
                signal.removeEventListener('abort', abortListener);
            }
            composite?.cleanup();
            parentComposite?.cleanup();
        }
    }
}
//# sourceMappingURL=nested-runner.js.map