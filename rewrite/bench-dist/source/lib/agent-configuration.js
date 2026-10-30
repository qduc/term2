import { buildAgent } from './agent-factory.js';
import { createEditorImpl } from './editor-impl.js';
import { getProvider } from '../providers/index.js';
import { ToolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';
import { bindRunCodeNestedApprovalOwner } from '../tools/system/run-code/run-code.js';
import { TurnStableMcpToolSource } from '../services/mcp/turn-stable-mcp-tool-source.js';
import { ModelSelectionSchema } from '../services/settings/model-selection.js';
export class AgentConfiguration {
    #agent;
    #selection;
    #reasoningEffort;
    #temperature;
    #isTransientClient;
    #editor;
    #approvalPolicyRegistry;
    #nestedApprovalOwner;
    // Service references (for #buildFactoryDeps)
    // Callback for side effects before rebuild
    #onConfigChanged;
    #driverFactory;
    #modelBinding;
    #assembleAgent;
    #providerCapabilities;
    #logger;
    #settings;
    #getGoal;
    #proposeGoal;
    #executionContext;
    #toolInterceptorRegistry;
    #askUserAnswerStore;
    #getSubagentBridge;
    #serviceTierOverrideForNextRequest = null;
    #skillsService;
    #postExecutePauseCapability;
    #sessionAccess;
    #readOnly;
    #allowUnsandboxed;
    #backgroundShellRegistry;
    #backgroundShellOutput;
    #shellChildRegistry;
    #scopedSandbox;
    #allowBackgroundShell;
    #allowAskUser;
    #sessionBrowser;
    #discordSend;
    #isDiscordInputEnabled;
    #requestSessionRollover;
    #configureTaskCheckIn;
    #setTaskCheckInPolicy;
    #mcpToolSource;
    #worktreeScope;
    #worktreePaths;
    #listWorktreesSync;
    #globalMemoryContextSnapshot;
    #unsubscribeSettings = null;
    #isDisposed = false;
    constructor(config, deps) {
        // Store deps
        this.#driverFactory = deps.driverFactory;
        this.#modelBinding = deps.modelBinding;
        this.#assembleAgent = deps.assembleAgent;
        this.#providerCapabilities = deps.providerCapabilities;
        this.#logger = deps.logger;
        this.#settings = deps.settings;
        this.#getGoal = deps.getGoal;
        this.#proposeGoal = deps.proposeGoal;
        this.#executionContext = deps.executionContext;
        this.#toolInterceptorRegistry = deps.toolInterceptorRegistry;
        this.#askUserAnswerStore = deps.askUserAnswerStore;
        this.#getSubagentBridge = deps.getSubagentBridge;
        this.#onConfigChanged = deps.onConfigChanged;
        this.#skillsService = deps.skillsService;
        this.#postExecutePauseCapability = deps.postExecutePauseCapability;
        this.#sessionAccess = deps.sessionAccess;
        this.#readOnly = deps.readOnly ?? false;
        this.#allowUnsandboxed = deps.allowUnsandboxed ?? true;
        this.#backgroundShellRegistry = deps.backgroundShellRegistry;
        this.#backgroundShellOutput = deps.backgroundShellOutput;
        this.#shellChildRegistry = deps.shellChildRegistry;
        this.#scopedSandbox = deps.scopedSandbox;
        this.#allowBackgroundShell = deps.allowBackgroundShell ?? true;
        this.#allowAskUser = deps.allowAskUser ?? true;
        this.#sessionBrowser = deps.sessionBrowser;
        this.#discordSend = deps.discordSend;
        this.#isDiscordInputEnabled = deps.isDiscordInputEnabled;
        this.#requestSessionRollover = deps.requestSessionRollover;
        this.#configureTaskCheckIn = deps.configureTaskCheckIn;
        this.#setTaskCheckInPolicy = deps.setTaskCheckInPolicy;
        this.#mcpToolSource = deps.mcpToolSource ? new TurnStableMcpToolSource(deps.mcpToolSource) : undefined;
        this.#worktreeScope = deps.worktreeScope;
        this.#worktreePaths = deps.worktreePaths;
        this.#listWorktreesSync = deps.listWorktreesSync;
        this.#approvalPolicyRegistry = config.approvalPolicyRegistry ?? new ToolApprovalPolicyRegistry();
        // Create editor
        this.#editor = createEditorImpl({
            loggingService: this.#logger,
            settingsService: this.#settings,
            executionContext: this.#executionContext,
        });
        // Initialize config
        this.#reasoningEffort = config.reasoningEffort;
        this.#temperature = config.temperature ?? this.#settings.get('agent.temperature');
        this.#selection = ModelSelectionSchema.parse(config.selection ?? this.#settings.get('agent.modelSelection'));
        if (config.agentOverride) {
            this.#isTransientClient = true;
            this.#agent = config.agentOverride;
        }
        else {
            this.#isTransientClient = false;
            const buildResult = (this.#assembleAgent ?? buildAgent)({ selection: this.#selection, reasoningEffort: config.reasoningEffort }, this.#buildFactoryDeps());
            this.#agent = buildResult.agent;
            this.#selection = buildResult.selection;
        }
    }
    // AgentSource implementation
    getAgent(sessionId, promptCacheKey) {
        if (sessionId && !this.#isTransientClient) {
            const capabilities = this.#providerCapabilities
                ? this.#providerCapabilities(this.#selection.provider)
                : getProvider(this.#selection.provider)?.capabilities;
            const supportsPromptCacheKey = capabilities?.supportsPromptCacheKey;
            if (!supportsPromptCacheKey || !sessionId) {
                return this.#agent;
            }
            const cacheKey = promptCacheKey ?? sessionId;
            if (capabilities?.promptCacheKeyPlacement !== 'responses-extra-body') {
                return { ...this.#agent, modelSettings: { ...(this.#agent.modelSettings ?? {}), prompt_cache_key: cacheKey } };
            }
            return {
                ...this.#agent,
                modelSettings: {
                    ...(this.#agent.modelSettings ?? {}),
                    providerData: {
                        ...(this.#agent.modelSettings?.providerData ?? {}),
                        extraBody: {
                            ...(this.#agent.modelSettings?.providerData?.extraBody ?? {}),
                            prompt_cache_key: cacheKey,
                        },
                    },
                },
            };
        }
        return this.#agent;
    }
    /** Advance the MCP catalog snapshot at the real start of a provider turn. */
    beginTurn() {
        this.#mcpToolSource?.beginTurn();
    }
    getProvider() {
        return this.#selection.provider;
    }
    getModel() {
        return this.#selection.model;
    }
    /**
     * Build the SDK-free agent definition consumed by the application run loop.
     * The legacy SDK Agent remains available to the compatibility path until
     * every provider has moved to the application-owned model boundary.
     */
    getApplicationAgent(sessionId, promptCacheKey) {
        // The agent held by this configuration is already the factory-wrapped
        // application definition. Rebuilding from getAgentDefinition here loses
        // wrapped tool behavior (interceptors, approvals, and post-execute
        // gates), and used to discard transient/override agents altogether.
        const agent = this.getAgent(sessionId, promptCacheKey);
        if (this.#selection.provider !== 'codex' || !agent.modelSettings)
            return agent;
        return {
            ...agent,
            modelSettings: toApplicationCodexSettings(agent.modelSettings),
        };
    }
    // Build the factory deps (used by buildAgent and for agent rebuilds)
    #buildFactoryDeps(approvalPolicyRegistry = this.#approvalPolicyRegistry) {
        return {
            driverFactory: this.#driverFactory,
            modelBinding: this.#modelBinding,
            settings: this.#settings,
            logger: this.#logger,
            ...(this.#getGoal ? { getGoal: this.#getGoal } : {}),
            ...(this.#proposeGoal ? { proposeGoal: this.#proposeGoal } : {}),
            executionContext: this.#executionContext,
            editor: this.#editor,
            approvalPolicyRegistry,
            providerId: this.#selection.provider,
            serviceTierOverrideForNextRequest: this.#serviceTierOverrideForNextRequest,
            createMentor: (...args) => this.#getSubagentBridge().createMentor(...args),
            runSubagent: (...args) => this.#getSubagentBridge().runSubagent(...args),
            runSubagentAsync: (...args) => this.#getSubagentBridge().runSubagentAsync(...args),
            getSubagentResult: (...args) => this.#getSubagentBridge().getSubagentResult(...args),
            getSubagentStatus: (...args) => this.#getSubagentBridge().getSubagentStatus(...args),
            sendSubagentMessage: (...args) => this.#getSubagentBridge().sendSubagentMessage(...args),
            cancelSubagentRun: (...args) => this.#getSubagentBridge().cancelSubagentRun(...args),
            runResolvedSubagent: (...args) => this.#getSubagentBridge().runResolvedSubagent(...args),
            runResolvedSubagentAsync: (...args) => this.#getSubagentBridge().runResolvedSubagentAsync(...args),
            getAskUserAnswer: this.#allowAskUser
                ? (callId) => {
                    if (!callId)
                        return undefined;
                    return this.#askUserAnswerStore.consume(callId);
                }
                : undefined,
            checkToolInterceptors: (name, params, toolCallId) => this.#toolInterceptorRegistry.check(name, params, toolCallId),
            skillsService: this.#skillsService,
            getAgentRuntime: () => ({
                agent: (config) => {
                    const runtime = this.#getSubagentBridge()?.getAgentRuntime();
                    if (!runtime)
                        throw new Error('Agent runtime is unavailable');
                    return runtime.agent(config);
                },
            }),
            postExecutePauseCapability: this.#postExecutePauseCapability,
            sessionAccess: this.#sessionAccess,
            readOnly: this.#readOnly,
            allowUnsandboxed: this.#allowUnsandboxed,
            backgroundShellRegistry: this.#backgroundShellRegistry,
            backgroundShellOutput: this.#backgroundShellOutput,
            shellChildRegistry: this.#shellChildRegistry,
            scopedSandbox: this.#scopedSandbox,
            allowBackgroundShell: this.#allowBackgroundShell,
            allowAskUser: this.#allowAskUser,
            sessionBrowser: this.#sessionBrowser,
            discordSend: this.#discordSend,
            isDiscordInputEnabled: this.#isDiscordInputEnabled,
            ...(this.#requestSessionRollover ? { requestSessionRollover: this.#requestSessionRollover } : {}),
            configureTaskCheckIn: this.#configureTaskCheckIn,
            setTaskCheckInPolicy: this.#setTaskCheckInPolicy,
            mcpToolSource: this.#mcpToolSource,
            snapshotGlobalMemoryContext: (read) => {
                if (this.#globalMemoryContextSnapshot === undefined)
                    this.#globalMemoryContextSnapshot = read();
                return this.#globalMemoryContextSnapshot;
            },
            ...(this.#worktreeScope ? { worktreeScope: this.#worktreeScope } : {}),
            ...(this.#worktreePaths ? { worktreePaths: this.#worktreePaths } : {}),
            ...(this.#listWorktreesSync ? { listWorktreesSync: this.#listWorktreesSync } : {}),
        };
    }
    // Expose buildFactoryDeps for AgentClient to use
    getBuildFactoryDeps() {
        return this.#buildFactoryDeps();
    }
    get approvalPolicyRegistry() {
        return this.#approvalPolicyRegistry;
    }
    setNestedApprovalOwner(owner) {
        this.#nestedApprovalOwner = owner;
        if (owner)
            bindRunCodeNestedApprovalOwner(this.#agent.tools, owner);
    }
    // Rebuild the agent with current config
    rebuildAgent() {
        if (this.#isTransientClient)
            return;
        const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
        const buildResult = (this.#assembleAgent ?? buildAgent)({
            selection: this.#selection,
            reasoningEffort: this.#reasoningEffort,
            temperature: this.#temperature,
        }, this.#buildFactoryDeps(approvalPolicyRegistry));
        this.#agent = buildResult.agent;
        this.#selection = buildResult.selection;
        this.#approvalPolicyRegistry = approvalPolicyRegistry;
        if (this.#nestedApprovalOwner)
            bindRunCodeNestedApprovalOwner(this.#agent.tools, this.#nestedApprovalOwner);
    }
    /** Rollover retains this client but starts a new instruction-cache lifetime. */
    resetMemoryContextForNewSession() {
        this.#globalMemoryContextSnapshot = undefined;
        this.rebuildAgent();
    }
    /** Subscribe to settings changes that affect agent definition and rebuild automatically. */
    subscribeToSettings() {
        if (this.#isTransientClient || this.#isDisposed || this.#unsubscribeSettings)
            return;
        const rebuildKeys = [
            'app.activeProfileId',
            'enable_agent_workflow',
            'app.searchViaShell',
            'agent.modelSelection',
            'agent.transport',
            'agent.retryAttempts',
            'agent.maxOutputTokens',
            'agent.maxStreamOutputChars',
            'agent.maxModelRequestDurationMs',
            'agent.maxModelStreamIdleMs',
            // Provider model factories snapshot credentials, endpoints, and other
            // transport settings. Rebuild and notify consumers when any of these
            // change so cached application models cannot outlive their settings.
            'agent.openai.apiKey',
            'agent.openrouter.apiKey',
            'agent.openrouter.baseUrl',
            'agent.openrouter.referrer',
            'agent.openrouter.title',
            'agent.codex.websocketFirstFrameTimeoutMs',
            'agent.codex.websocketInterFrameTimeoutMs',
            'providers',
            'agent.reasoningEffort',
            'agent.temperature',
            'agent.useFlexServiceTier',
            'agent.maxRequestInputTokens',
            'agent.contextCompaction.enabled',
            'agent.contextCompaction.mode',
            'agent.contextCompaction.compactThreshold',
            'agent.contextCompaction.compactThresholdTokens',
            'agent.smartModel',
            'agent.balancedModel',
            'agent.cheapModel',
            'agent.choreModel',
            'agent.mentorPool',
            'agent.mentorReasoningEffort',
            'agent.subagentExplorerReasoningEffort',
            'agent.subagentWorkerReasoningEffort',
            'agent.subagentLibrarianReasoningEffort',
            'logging.logLevel',
            'logging.suppressConsoleOutput',
        ];
        if (typeof this.#settings.onChange !== 'function')
            return;
        this.#unsubscribeSettings = this.#settings.onChange((changedKey) => {
            if (this.#isDisposed)
                return;
            if (!changedKey)
                return;
            if (rebuildKeys.includes(changedKey)) {
                if (changedKey === 'agent.modelSelection') {
                    this.#selection = ModelSelectionSchema.parse(this.#settings.get('agent.modelSelection'));
                }
                this.#onConfigChanged?.(changedKey);
                this.rebuildAgent();
            }
        });
    }
    /** Stop receiving settings changes from this session-bound configuration. */
    dispose() {
        if (this.#isDisposed)
            return;
        this.#isDisposed = true;
        const unsubscribe = this.#unsubscribeSettings;
        this.#unsubscribeSettings = null;
        unsubscribe?.();
    }
    /**
     * Refresh the agent with current settings. Per-turn refreshes do not
     * invalidate models whose session-scoped transports are still reusable.
     */
    refreshAgent(options = {}) {
        if (this.#isTransientClient)
            return;
        if (options.configurationChanged !== false)
            this.#onConfigChanged?.();
        this.rebuildAgent();
    }
    // Setters — used by AgentClient before calling rebuildAgent()
    setModelSelection(selection) {
        this.#selection = ModelSelectionSchema.parse(selection);
    }
    setReasoningEffort(effort) {
        this.#reasoningEffort = effort;
    }
    setTemperature(temperature) {
        this.#temperature = temperature;
    }
    // Exposed accessors
    get editor() {
        return this.#editor;
    }
    get isTransientClient() {
        return this.#isTransientClient;
    }
    /** The latest persisted session goal; transient (subagent/role) clients never carry one. */
    get goalSource() {
        return this.#isTransientClient ? undefined : this.#getGoal;
    }
    get serviceTierOverrideForNextRequest() {
        return this.#serviceTierOverrideForNextRequest;
    }
    set serviceTierOverrideForNextRequest(value) {
        this.#serviceTierOverrideForNextRequest = value;
    }
    get temperature() {
        return this.#temperature;
    }
    get reasoningEffort() {
        return this.#reasoningEffort;
    }
    get maxTurns() {
        return this.#settings.get('agent.maxTurns') ?? 20;
    }
}
/** Converts legacy Codex model settings into the typed application turn representation. */
function toApplicationCodexSettings(settings) {
    if (!settings)
        return settings;
    const { prompt_cache_key, include, codex, ...rest } = settings;
    const promptCacheKey = typeof codex?.promptCacheKey === 'string'
        ? codex.promptCacheKey
        : typeof prompt_cache_key === 'string'
            ? prompt_cache_key
            : undefined;
    const codexInclude = Array.isArray(codex?.include)
        ? codex.include
        : Array.isArray(include)
            ? include.filter((value) => typeof value === 'string')
            : undefined;
    return {
        ...rest,
        ...(promptCacheKey !== undefined || codexInclude !== undefined
            ? {
                codex: {
                    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
                    ...(codexInclude !== undefined ? { include: codexInclude } : {}),
                },
            }
            : {}),
    };
}
//# sourceMappingURL=agent-configuration.js.map