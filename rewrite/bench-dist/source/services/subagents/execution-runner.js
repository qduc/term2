import { resolveOutputAllocation } from '../agent-runtime/model-context-policy.js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SANDBOX_TEMP_DIR } from '../../utils/shell/temp-dir.js';
import { SubagentSession } from './subagent-session.js';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import { isAbortLike, aggregateToolUsage, safeEmit, isMaxTurnsExceededError, extractMaxTurnsLimit, buildTurnBudgetExhaustedFinalText, } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import { buildInstructions, resolveSubagentSearchViaShell } from './role-loader.js';
import { createSessionRuntime } from '../../core/session-runtime.js';
import { AcquiredChildSlot } from '../agent-runtime/execution-budget.js';
import { pinWorkerWorktree } from './worker-worktree.js';
import { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import { getCatalogModel } from '../../providers/model-catalog/catalog.js';
const MAX_PEEK_TEXT_LENGTH = 200;
const STREAMING_TOOL_PROGRESS_STEP = 1_024;
export class ExecutionSubagentRunner {
    #logger;
    #settings;
    #sessionContextService;
    #executionContext;
    #createClient;
    #toolFactory;
    #onEvent;
    #skillsService;
    #toolOwnership;
    constructor(deps) {
        this.#logger = deps.logger;
        this.#settings = deps.settings;
        this.#sessionContextService = deps.sessionContextService;
        this.#executionContext = deps.executionContext;
        this.#createClient = deps.createClient;
        this.#toolFactory = deps.toolFactory;
        this.#onEvent = deps.onEvent;
        this.#skillsService = deps.skillsService;
        this.#toolOwnership = deps.toolOwnership;
    }
    async run(agentId, request, definition) {
        return this.#execute(agentId, request, definition, new SubagentSession(agentId, request.role), undefined, request.signal, undefined, undefined, request.task);
    }
    async runInSession(agentId, request, definition, session, providedChildSlot, signal, onEventOverride, segmentControl, input = request.task) {
        return this.#execute(agentId, request, definition, session, providedChildSlot, signal, onEventOverride, segmentControl, input);
    }
    async #execute(agentId, request, definition, session, providedChildSlot, signal, onEventOverride, segmentControl, input) {
        if (!this.#createClient) {
            throw new Error('SubagentManager: createClient factory not provided');
        }
        let runExecutionContext = this.#executionContext;
        let worktreePath;
        if (request.worktree) {
            const pin = await pinWorkerWorktree({
                name: request.worktree,
                role: request.role,
                homeRoot: this.#executionContext?.getHomeWorkspace() ?? process.cwd(),
                isRemote: this.#executionContext?.isRemote() ?? false,
                authorizedPath: request.authorizedWorktreePath,
            });
            if (!pin.ok) {
                return {
                    agentId,
                    role: request.role,
                    status: 'failed',
                    finalText: '',
                    filesChanged: [],
                    toolsUsed: [],
                    error: pin.error,
                };
            }
            runExecutionContext = pin.executionContext;
            worktreePath = pin.worktreePath;
        }
        // ── Budget enforcement ──
        // Root executions do NOT consume a child slot; only actual nested
        // agent runs do. The root budget tracks children, not itself.
        let childSlot = providedChildSlot;
        let executionBudget = definition.executionBudget;
        if (definition.executionBudget && !definition.isRootExecution && !childSlot) {
            executionBudget = definition.executionBudget.createChildBudget();
            const slot = definition.executionBudget.tryAcquireChild();
            if (!(slot instanceof AcquiredChildSlot)) {
                return {
                    agentId,
                    role: request.role,
                    status: 'failed',
                    finalText: '',
                    filesChanged: [],
                    toolsUsed: [],
                    error: `Budget exhausted: ${slot.reason}${slot.max !== undefined ? ` (${slot.current}/${slot.max})` : ''}`,
                    ...(worktreePath ? { worktreePath } : {}),
                };
            }
            childSlot = slot;
        }
        const toolCounts = new Map();
        const filesChanged = [];
        const diffDeltas = new Map();
        const validationCapture = {};
        const searchViaShell = resolveSubagentSearchViaShell(this.#settings, definition.canRunShell);
        const toolDefinitions = this.#toolFactory.buildToolDefinitions(definition, filesChanged, request.task, searchViaShell, false, diffDeltas, validationCapture, segmentControl ? (question) => segmentControl.askOrchestrator(question) : undefined, runExecutionContext && runExecutionContext !== this.#executionContext
            ? { executionContext: runExecutionContext }
            : undefined);
        const providerId = definition.provider;
        // The subagent graph owns this registry: wrapped tool policies register
        // here, and the transient client below exposes the same instance so the
        // subagent session resolves its own graph's policies (never an empty
        // registry, never the root graph's via the old singleton echo).
        const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
        const tools = this.#toolFactory.buildAgentTools(toolDefinitions, {
            providerId,
            approvalPolicyRegistry,
            onToolStart: (name) => {
                toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
                segmentControl?.onToolStart();
            },
            onToolComplete: () => {
                segmentControl?.onToolComplete();
            },
        });
        const modelSettings = {
            retry: { maxRetries: this.#settings.get('agent.retryAttempts') ?? 2 },
        };
        if (definition.reasoningEffort && definition.reasoningEffort !== 'default') {
            modelSettings.reasoning = { effort: definition.reasoningEffort, summary: 'auto' };
        }
        // One-shot clients use this agent verbatim, bypassing the root factory.
        // Inherit selected generation controls; an explicit role output override
        // retains its existing precedence over the global output default.
        const maxTokens = definition.maxTokens ?? this.#settings.get('agent.maxOutputTokens');
        if (typeof maxTokens === 'number') {
            modelSettings.maxTokens =
                definition.maxTokens !== undefined
                    ? maxTokens
                    : resolveOutputAllocation(getCatalogModel(providerId, definition.model), maxTokens, this.#settings.getSource?.('agent.maxOutputTokens') === 'default');
        }
        for (const key of ['maxStreamOutputChars', 'maxModelRequestDurationMs', 'maxModelStreamIdleMs']) {
            const value = this.#settings.get(`agent.${key}`);
            if (typeof value === 'number')
                modelSettings[key] = value;
        }
        const fullInstructions = buildInstructions(definition, toolDefinitions, searchViaShell, this.#settings, runExecutionContext, this.#skillsService);
        const agent = {
            name: definition.name,
            model: definition.model,
            ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
            instructions: fullInstructions,
            tools,
        };
        const subClient = this.#createClient({
            agent,
            provider: providerId,
            maxTurns: definition.maxTurns,
            retryAttempts: this.#settings.get('agent.retryAttempts') ?? 2,
            approvalPolicyRegistry,
        });
        const runtime = createSessionRuntime({
            sessionId: `subagent-${agentId}`,
            agentClient: subClient,
            toolOwnership: this.#toolOwnership,
            deps: {
                logger: this.#logger,
                settingsService: this.#settings,
                sessionContextService: this.#sessionContextService,
            },
            retryOptions: {
                allowFreshStartRetries: false,
            },
        });
        const initialState = session.exportState();
        if (initialState.history.length > 0) {
            runtime.state.importState(initialState);
        }
        const onEvent = onEventOverride ?? this.#onEvent;
        const userTurn = { text: input, images: [] };
        let finalText = '';
        let usage = undefined;
        let costRecords;
        let error;
        let subagentStatus = 'completed';
        let terminalCause;
        let loopProcessedError = false;
        let currentText = '';
        let emittedUsageUpdate = false;
        let streamingToolName;
        let lastStreamingToolProgress = 0;
        try {
            for await (const event of runtime.turns.start(userTurn, {
                signal,
                maxModelRetries: MAX_SUBAGENT_MODEL_RETRIES,
            })) {
                switch (event.type) {
                    case 'text_delta':
                        currentText = `${currentText}${event.delta}`.slice(0, MAX_PEEK_TEXT_LENGTH);
                        await safeEmit(this.#logger, onEvent, {
                            type: 'subagent_streaming_text',
                            agentId,
                            text: currentText,
                        }, { propagate: true });
                        break;
                    case 'tool_call_streaming_delta': {
                        if (!event.toolName)
                            break;
                        const newTool = event.toolName !== streamingToolName || event.argumentCharCount < lastStreamingToolProgress;
                        if (newTool ||
                            lastStreamingToolProgress === 0 ||
                            event.argumentCharCount >= lastStreamingToolProgress + STREAMING_TOOL_PROGRESS_STEP) {
                            streamingToolName = event.toolName;
                            lastStreamingToolProgress = event.argumentCharCount;
                            await safeEmit(this.#logger, onEvent, {
                                type: 'subagent_streaming_tool',
                                agentId,
                                toolName: event.toolName,
                                argumentCharCount: event.argumentCharCount,
                            }, { propagate: true });
                        }
                        break;
                    }
                    case 'tool_started':
                        streamingToolName = undefined;
                        lastStreamingToolProgress = 0;
                        if (currentText.trim()) {
                            await safeEmit(this.#logger, onEvent, {
                                type: 'subagent_text_turn',
                                agentId,
                                role: request.role,
                                text: currentText,
                            }, { propagate: true });
                            currentText = '';
                        }
                        if (event.toolName) {
                            await safeEmit(this.#logger, onEvent, {
                                type: 'subagent_tool_started',
                                agentId,
                                role: request.role,
                                toolCallId: event.toolCallId,
                                toolName: event.toolName,
                                arguments: event.arguments,
                            }, { propagate: true });
                        }
                        break;
                    case 'command_message':
                        await safeEmit(this.#logger, onEvent, {
                            type: 'subagent_command_message',
                            agentId,
                            role: request.role,
                            message: event.message,
                        }, { propagate: true });
                        break;
                    case 'final':
                        streamingToolName = undefined;
                        lastStreamingToolProgress = 0;
                        if (currentText.trim()) {
                            await safeEmit(this.#logger, onEvent, {
                                type: 'subagent_text_turn',
                                agentId,
                                role: request.role,
                                text: currentText,
                            }, { propagate: true });
                            currentText = '';
                        }
                        finalText = event.finalText;
                        terminalCause = event.terminalCause;
                        if (terminalCause)
                            subagentStatus = 'interrupted';
                        if (event.usage) {
                            usage = event.usage;
                            if (!emittedUsageUpdate) {
                                await safeEmit(this.#logger, onEvent, { type: 'subagent_usage_update', agentId, usage: event.usage }, { propagate: true });
                                emittedUsageUpdate = true;
                            }
                        }
                        if (event.costRecords && event.costRecords.length > 0)
                            costRecords = event.costRecords;
                        break;
                    case 'usage_update':
                        if (event.usage)
                            usage = event.usage;
                        await safeEmit(this.#logger, onEvent, {
                            type: 'subagent_usage_update',
                            agentId,
                            usage: event.usage,
                        }, { propagate: true });
                        emittedUsageUpdate = true;
                        break;
                    case 'run_budget':
                        await safeEmit(this.#logger, onEvent, {
                            type: 'subagent_run_budget',
                            agentId,
                            role: request.role,
                            event: event.evidence,
                        }, { propagate: true });
                        break;
                    case 'error':
                        streamingToolName = undefined;
                        lastStreamingToolProgress = 0;
                        error = new Error(event.message);
                        loopProcessedError = true;
                        subagentStatus = isAbortLike(event.message, event) ? 'cancelled' : 'failed';
                        break;
                    case 'retry':
                        currentText = '';
                        streamingToolName = undefined;
                        lastStreamingToolProgress = 0;
                        await safeEmit(this.#logger, onEvent, {
                            type: 'subagent_retry',
                            toolName: event.toolName,
                            attempt: event.attempt,
                            maxRetries: event.maxRetries,
                            errorMessage: event.errorMessage,
                            retryType: event.retryType,
                            agentId,
                        }, { propagate: true });
                        break;
                }
            }
        }
        catch (err) {
            if (!error) {
                error = err instanceof Error ? err : new Error(String(err));
            }
            if (!loopProcessedError) {
                subagentStatus = isAbortLike(error.message, error) || isAbortLike(err?.message, err) ? 'cancelled' : 'failed';
            }
            if (!usage) {
                usage = normalizeAgentRunUsage(err?.state?.usage) ?? extractUsage(err);
            }
            if (usage && !emittedUsageUpdate) {
                await safeEmit(this.#logger, onEvent, { type: 'subagent_usage_update', agentId, usage }, { propagate: true });
            }
        }
        finally {
            try {
                const exported = runtime.state.exportState();
                session.importState(exported);
                const messageCap = this.#settings.get('subagent.asyncMessageCap') ?? 50;
                session.trimHistory(messageCap);
            }
            catch (exportErr) {
                this.#logger.debug('Failed to export async subagent session state', {
                    agentId,
                    error: exportErr?.message || String(exportErr),
                });
            }
            // Record usage to the budget on every terminal path
            if (childSlot && usage) {
                executionBudget.recordUsage(usage);
            }
            // Release the child slot
            childSlot?.release();
            runtime.dispose();
            // This client is created for exactly one execution. State has already
            // been transferred above, so release its subscriptions/bridge now.
            subClient.dispose?.();
        }
        const diffStat = buildDiffStat(filesChanged, diffDeltas);
        const validation = validationCapture.value;
        // A legacy max-turn error has no terminal response to carry the typed cause;
        // retain this compatibility path, but never call the partial result done.
        if (error && isMaxTurnsExceededError(error) && signal?.aborted !== true) {
            const maxTurns = extractMaxTurnsLimit(error) ?? definition.maxTurns;
            this.#logger.warn('Subagent turn budget exhausted', {
                agentId,
                role: request.role,
                maxTurns,
            });
            const partialText = finalText.trim() || currentText.trim();
            const resultText = await truncateResultText(buildTurnBudgetExhaustedFinalText({ maxTurns, partialText }));
            return {
                agentId,
                role: request.role,
                status: 'interrupted',
                terminalCause: 'budget_exhausted',
                ...resultText,
                filesChanged: [...new Set(filesChanged)],
                toolsUsed: aggregateToolUsage(toolCounts),
                ...(usage ? { usage } : {}),
                ...(costRecords && costRecords.length > 0 ? { costRecords } : {}),
                ...(diffStat.length > 0 ? { diffStat } : {}),
                ...(validation ? { validation } : {}),
                ...(worktreePath ? { worktreePath } : {}),
            };
        }
        if (error) {
            return {
                agentId,
                role: request.role,
                status: subagentStatus,
                finalText: '',
                filesChanged: [...new Set(filesChanged)],
                toolsUsed: aggregateToolUsage(toolCounts),
                error: error.message,
                ...(usage ? { usage } : {}),
                ...(costRecords && costRecords.length > 0 ? { costRecords } : {}),
                ...(diffStat.length > 0 ? { diffStat } : {}),
                ...(validation ? { validation } : {}),
                ...(worktreePath ? { worktreePath } : {}),
            };
        }
        const resultText = await truncateResultText(finalText);
        return {
            agentId,
            role: request.role,
            status: subagentStatus,
            ...resultText,
            filesChanged: [...new Set(filesChanged)],
            toolsUsed: aggregateToolUsage(toolCounts),
            ...(usage ? { usage } : {}),
            ...(costRecords && costRecords.length > 0 ? { costRecords } : {}),
            ...(diffStat.length > 0 ? { diffStat } : {}),
            ...(validation ? { validation } : {}),
            ...(worktreePath ? { worktreePath } : {}),
            ...(terminalCause ? { terminalCause } : {}),
        };
    }
}
function buildDiffStat(filesChanged, diffDeltas) {
    const seen = new Set();
    const entries = [];
    for (const file of filesChanged) {
        if (seen.has(file))
            continue;
        seen.add(file);
        const delta = diffDeltas.get(file) ?? diffDeltas.get(resolveSafe(file));
        entries.push({
            path: file,
            added: delta?.added ?? 0,
            deleted: delta?.deleted ?? 0,
        });
    }
    return entries;
}
function resolveSafe(p) {
    try {
        return path.resolve(p);
    }
    catch {
        return p;
    }
}
const MAX_FINAL_TEXT_CHARS = 40_000;
const SUBAGENT_RESULT_DIR = path.join(SANDBOX_TEMP_DIR, 'subagent-result');
let subagentResultTempDirPromise;
async function truncateResultText(text) {
    if (text.length <= MAX_FINAL_TEXT_CHARS)
        return { finalText: text };
    const artifactPath = await saveSubagentResultArtifact(text);
    return {
        finalText: text.slice(0, MAX_FINAL_TEXT_CHARS) + `\n...(truncated)\nFull subagent result saved to \`${artifactPath}\``,
        finalTextTruncated: true,
        finalTextArtifactPath: artifactPath,
    };
}
async function saveSubagentResultArtifact(text) {
    subagentResultTempDirPromise ??= (async () => {
        await mkdir(SUBAGENT_RESULT_DIR, { recursive: true, mode: 0o700 });
        return SUBAGENT_RESULT_DIR;
    })();
    const tempDir = await subagentResultTempDirPromise;
    const suffix = randomBytes(3).toString('hex');
    const artifactPath = path.join(tempDir, `result-${process.pid}-${Date.now()}-${suffix}.md`);
    await writeFile(artifactPath, text, 'utf8');
    return artifactPath;
}
//# sourceMappingURL=execution-runner.js.map