import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ExecutionContext } from '../services/execution-context.js';
import type { ListWorktreesSync } from '../services/workspace/worktree-inventory.js';
import type { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import type { AskUserAnswerStore } from './ask-user-answer-store.js';
import type { SubagentBridge } from './subagent-bridge.js';
import type { AgentFactoryDeps } from './agent-factory.js';
import { buildAgent } from './agent-factory.js';
import { createEditorImpl } from './editor-impl.js';
import { getProvider } from '../providers/index.js';
import { SkillsService } from '../services/skills/skills-service.js';
import type { PostExecutePauseCapability } from '../tools/types.js';
import type { SessionAccessState } from '../services/session/session-access-state.js';
import type { ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import type { BackgroundShellRegistry } from '../services/shell/background-shell-registry.js';
import type { BackgroundShellOutputBundle } from '../services/shell/background-shell-watches.js';
import type { BackgroundShellExecutionResult } from '../tools/system/shell.js';
import type { ShellChildRegistry } from '../utils/shell/shell-child-registry.js';
import type { SessionBrowser } from '../services/conversation/session-browser.js';
import type { SessionRolloverRequest, SessionRolloverRequestOutcome } from '../contracts/session-rollover.js';
import { ToolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';
import type { NestedApprovalOwner } from '../services/approval/nested-approval-owner.js';
import { bindRunCodeNestedApprovalOwner } from '../tools/system/run-code/run-code.js';
import type { McpToolSource } from '../services/mcp/mcp-tool-source.js';
import { TurnStableMcpToolSource } from '../services/mcp/turn-stable-mcp-tool-source.js';
import type { DurableGoal } from '../services/logging/conversation-log-events.js';
import { ModelSelectionSchema, type ModelSelection } from '../services/settings/model-selection.js';

/** Narrow capability interface consumed by chat/session clients. */
export interface AgentSource {
  getAgent(sessionId?: string, promptCacheKey?: string): ApplicationAgent;
  getProvider(): string;
  getModel(): string;
}

export interface AgentConfigurationDeps {
  logger: ILoggingService;
  settings: ISettingsService;
  getGoal?: () => DurableGoal | undefined;
  /** Interactive-only goal proposal callbacks; absent in non-interactive/gateway sessions. */
  proposeGoal?: { appendGoal: (goal: DurableGoal) => void; hasPriorProposal: () => boolean };
  sessionContextService: ISessionContextService;
  executionContext?: ExecutionContext;
  toolInterceptorRegistry: ToolInterceptorRegistry;
  askUserAnswerStore: AskUserAnswerStore;
  /** Lazy accessor — SubagentBridge is created after AgentConfiguration. */
  getSubagentBridge: () => SubagentBridge | null;
  /** Called when agent is about to be rebuilt — for side effects like cache clearing */
  onConfigChanged?: (changedKey?: string) => void;
  skillsService?: SkillsService;
  postExecutePauseCapability?: PostExecutePauseCapability;
  sessionAccess?: SessionAccessState;
  readOnly?: boolean;
  allowUnsandboxed?: boolean;
  /** Root-session-owned shell registry; nested clients omit it. */
  backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;
  /** Root-session-owned output store + watch layer; nested clients omit it. */
  backgroundShellOutput?: BackgroundShellOutputBundle;
  shellChildRegistry?: ShellChildRegistry;
  /** False for one-shot/non-interactive callers until their lifecycle is supported. */
  allowBackgroundShell?: boolean;
  /** False for non-interactive / headless sessions where user prompts cannot be answered. */
  allowAskUser?: boolean;
  /** Explicit interactive-root-only browser capability. */
  sessionBrowser?: SessionBrowser;
  requestSessionRollover?: (request: SessionRolloverRequest) => SessionRolloverRequestOutcome;
  configureTaskCheckIn?: (params: any) => any;
  setTaskCheckInPolicy?: (
    target: { kind: 'shell' | 'subagent'; id: string },
    options: { enabled?: boolean; intervalMs?: number },
  ) => void;
  mcpToolSource?: McpToolSource;
  worktreeScope?: ReadonlyArray<string>;
  worktreePaths?: Readonly<Record<string, string>>;
  listWorktreesSync?: ListWorktreesSync;
}

export class AgentConfiguration implements AgentSource {
  #agent: ApplicationAgent;
  #selection: ModelSelection;
  #reasoningEffort?: ReasoningEffortSetting | null;
  #temperature?: number;
  #isTransientClient: boolean;
  #editor: ReturnType<typeof createEditorImpl>;
  #approvalPolicyRegistry: ToolApprovalPolicyRegistry;
  #nestedApprovalOwner?: NestedApprovalOwner;

  // Service references (for #buildFactoryDeps)
  // Callback for side effects before rebuild
  #onConfigChanged?: (changedKey?: string) => void;

  #logger: ILoggingService;
  #settings: ISettingsService;
  #getGoal?: () => DurableGoal | undefined;
  #proposeGoal?: { appendGoal: (goal: DurableGoal) => void; hasPriorProposal: () => boolean };
  #executionContext?: ExecutionContext;
  #toolInterceptorRegistry: ToolInterceptorRegistry;
  #askUserAnswerStore: AskUserAnswerStore;
  #getSubagentBridge: () => SubagentBridge | null;
  #serviceTierOverrideForNextRequest: 'standard' | null = null;
  #skillsService?: SkillsService;
  #postExecutePauseCapability?: PostExecutePauseCapability;
  #sessionAccess?: SessionAccessState;
  #readOnly: boolean;
  #allowUnsandboxed: boolean;
  #backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;
  #backgroundShellOutput?: BackgroundShellOutputBundle;
  #shellChildRegistry?: ShellChildRegistry;
  #allowBackgroundShell: boolean;
  #allowAskUser: boolean;
  #sessionBrowser?: SessionBrowser;
  #requestSessionRollover?: (request: SessionRolloverRequest) => SessionRolloverRequestOutcome;
  #configureTaskCheckIn?: (params: any) => any;
  #setTaskCheckInPolicy?: (
    target: { kind: 'shell' | 'subagent'; id: string },
    options: { enabled?: boolean; intervalMs?: number },
  ) => void;
  #mcpToolSource?: TurnStableMcpToolSource;
  #worktreeScope?: ReadonlyArray<string>;
  #worktreePaths?: Readonly<Record<string, string>>;
  #listWorktreesSync?: ListWorktreesSync;
  #globalMemoryContextSnapshot?: string;
  #unsubscribeSettings: (() => void) | null = null;
  #isDisposed = false;

  constructor(
    config: {
      selection?: ModelSelection;
      reasoningEffort?: ReasoningEffortSetting | null;
      temperature?: number;
      agentOverride?: ApplicationAgent;
      /**
       * Externally built graph registry (subagent runs). A transient client
       * never builds a graph, so without this its registry stays empty.
       */
      approvalPolicyRegistry?: ToolApprovalPolicyRegistry;
    },
    deps: AgentConfigurationDeps,
  ) {
    // Store deps
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
    this.#allowBackgroundShell = deps.allowBackgroundShell ?? true;
    this.#allowAskUser = deps.allowAskUser ?? true;
    this.#sessionBrowser = deps.sessionBrowser;
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

    } else {
      this.#isTransientClient = false;
      const buildResult = buildAgent(
        { selection: this.#selection, reasoningEffort: config.reasoningEffort },
        this.#buildFactoryDeps(),
      );
      this.#agent = buildResult.agent;
      this.#selection = buildResult.selection;
    }
  }

  // AgentSource implementation
  getAgent(sessionId?: string, promptCacheKey?: string): ApplicationAgent {
    if (sessionId && !this.#isTransientClient) {
      const capabilities = getProvider(this.#selection.provider)?.capabilities;
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
            ...((this.#agent.modelSettings?.providerData as any) ?? {}),
            extraBody: {
              ...((this.#agent.modelSettings?.providerData as any)?.extraBody ?? {}),
              prompt_cache_key: cacheKey,
            },
          },
        },
      };
    }
    return this.#agent;
  }

  /** Advance the MCP catalog snapshot at the real start of a provider turn. */
  beginTurn(): void {
    this.#mcpToolSource?.beginTurn();
  }

  getProvider(): string {
    return this.#selection.provider;
  }

  getModel(): string {
    return this.#selection.model;
  }

  /**
   * Build the SDK-free agent definition consumed by the application run loop.
   * The legacy SDK Agent remains available to the compatibility path until
   * every provider has moved to the application-owned model boundary.
   */
  getApplicationAgent(sessionId?: string, promptCacheKey?: string): ApplicationAgent {
    // The agent held by this configuration is already the factory-wrapped
    // application definition. Rebuilding from getAgentDefinition here loses
    // wrapped tool behavior (interceptors, approvals, and post-execute
    // gates), and used to discard transient/override agents altogether.
    const agent = this.getAgent(sessionId, promptCacheKey);
    if (this.#selection.provider !== 'codex' || !agent.modelSettings) return agent;
    return {
      ...agent,
      modelSettings: toApplicationCodexSettings(agent.modelSettings),
    };
  }

  // Build the factory deps (used by buildAgent and for agent rebuilds)
  #buildFactoryDeps(approvalPolicyRegistry = this.#approvalPolicyRegistry): AgentFactoryDeps {
    return {
      settings: this.#settings,
      logger: this.#logger,
      ...(this.#getGoal ? { getGoal: this.#getGoal } : {}),
      ...(this.#proposeGoal ? { proposeGoal: this.#proposeGoal } : {}),
      executionContext: this.#executionContext,
      editor: this.#editor,
      approvalPolicyRegistry,
      providerId: this.#selection.provider,
      serviceTierOverrideForNextRequest: this.#serviceTierOverrideForNextRequest,
      createMentor: (...args) => this.#getSubagentBridge()!.createMentor(...args),
      runSubagent: (...args) => this.#getSubagentBridge()!.runSubagent(...args),
      runSubagentAsync: (...args) => this.#getSubagentBridge()!.runSubagentAsync(...args),
      getSubagentResult: (...args) => this.#getSubagentBridge()!.getSubagentResult(...args),
      getSubagentStatus: (...args) => this.#getSubagentBridge()!.getSubagentStatus(...args),
      sendSubagentMessage: (...args) => this.#getSubagentBridge()!.sendSubagentMessage(...args),
      cancelSubagentRun: (...args) => this.#getSubagentBridge()!.cancelSubagentRun(...args),
      runResolvedSubagent: (...args) => this.#getSubagentBridge()!.runResolvedSubagent(...args),
      runResolvedSubagentAsync: (...args) => this.#getSubagentBridge()!.runResolvedSubagentAsync(...args),
      getAskUserAnswer: this.#allowAskUser
        ? (callId?: string) => {
            if (!callId) return undefined;
            return this.#askUserAnswerStore.consume(callId);
          }
        : undefined,
      checkToolInterceptors: (name, params, toolCallId) =>
        this.#toolInterceptorRegistry.check(name, params, toolCallId),
      skillsService: this.#skillsService,
      getAgentRuntime: () => ({
        agent: (config: any) => {
          const runtime = this.#getSubagentBridge()?.getAgentRuntime();
          if (!runtime) throw new Error('Agent runtime is unavailable');
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
      allowBackgroundShell: this.#allowBackgroundShell,
      allowAskUser: this.#allowAskUser,
      sessionBrowser: this.#sessionBrowser,
      ...(this.#requestSessionRollover ? { requestSessionRollover: this.#requestSessionRollover } : {}),
      configureTaskCheckIn: this.#configureTaskCheckIn,
      setTaskCheckInPolicy: this.#setTaskCheckInPolicy,
      mcpToolSource: this.#mcpToolSource,
      snapshotGlobalMemoryContext: (read) => {
        if (this.#globalMemoryContextSnapshot === undefined) this.#globalMemoryContextSnapshot = read();
        return this.#globalMemoryContextSnapshot;
      },
      ...(this.#worktreeScope ? { worktreeScope: this.#worktreeScope } : {}),
      ...(this.#worktreePaths ? { worktreePaths: this.#worktreePaths } : {}),
      ...(this.#listWorktreesSync ? { listWorktreesSync: this.#listWorktreesSync } : {}),
    };
  }

  // Expose buildFactoryDeps for AgentClient to use
  getBuildFactoryDeps(): AgentFactoryDeps {
    return this.#buildFactoryDeps();
  }

  get approvalPolicyRegistry(): ToolApprovalPolicyRegistry {
    return this.#approvalPolicyRegistry;
  }

  setNestedApprovalOwner(owner: NestedApprovalOwner | undefined): void {
    this.#nestedApprovalOwner = owner;
    if (owner) bindRunCodeNestedApprovalOwner(this.#agent.tools, owner);
  }

  // Rebuild the agent with current config
  rebuildAgent(): void {
    if (this.#isTransientClient) return;
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    const buildResult = buildAgent(
      {
        selection: this.#selection,
        reasoningEffort: this.#reasoningEffort as any,
        temperature: this.#temperature,
      },
      this.#buildFactoryDeps(approvalPolicyRegistry),
    );
    this.#agent = buildResult.agent;
    this.#selection = buildResult.selection;
    this.#approvalPolicyRegistry = approvalPolicyRegistry;
    if (this.#nestedApprovalOwner) bindRunCodeNestedApprovalOwner(this.#agent.tools, this.#nestedApprovalOwner);
  }

  /** Rollover retains this client but starts a new instruction-cache lifetime. */
  resetMemoryContextForNewSession(): void {
    this.#globalMemoryContextSnapshot = undefined;
    this.rebuildAgent();
  }

  /** Subscribe to settings changes that affect agent definition and rebuild automatically. */
  subscribeToSettings(): void {
    if (this.#isTransientClient || this.#isDisposed || this.#unsubscribeSettings) return;

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

    if (typeof this.#settings.onChange !== 'function') return;

    this.#unsubscribeSettings = this.#settings.onChange((changedKey) => {
      if (this.#isDisposed) return;
      if (!changedKey) return;
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
  dispose(): void {
    if (this.#isDisposed) return;
    this.#isDisposed = true;
    const unsubscribe = this.#unsubscribeSettings;
    this.#unsubscribeSettings = null;
    unsubscribe?.();
  }

  /**
   * Refresh the agent: triggers side effects (via `onConfigChanged`)
   * then rebuilds the agent with current settings.
   */
  refreshAgent(): void {
    if (this.#isTransientClient) return;
    this.#onConfigChanged?.();
    this.rebuildAgent();
  }

  // Setters — used by AgentClient before calling rebuildAgent()

  setModelSelection(selection: ModelSelection): void {
    this.#selection = ModelSelectionSchema.parse(selection);
  }

  setReasoningEffort(effort?: ReasoningEffortSetting): void {
    this.#reasoningEffort = effort;
  }

  setTemperature(temperature?: number): void {
    this.#temperature = temperature;
  }


  // Exposed accessors

  get editor() {
    return this.#editor;
  }

  get isTransientClient() {
    return this.#isTransientClient;
  }

  get serviceTierOverrideForNextRequest() {
    return this.#serviceTierOverrideForNextRequest;
  }

  set serviceTierOverrideForNextRequest(value: 'standard' | null) {
    this.#serviceTierOverrideForNextRequest = value;
  }

  get temperature() {
    return this.#temperature;
  }

  get reasoningEffort() {
    return this.#reasoningEffort;
  }

  get maxTurns(): number {
    return this.#settings.get('agent.maxTurns') ?? 20;
  }
}

/** Converts legacy Codex model settings into the typed application turn representation. */
function toApplicationCodexSettings(settings: ApplicationAgent['modelSettings']): ApplicationAgent['modelSettings'] {
  if (!settings) return settings;
  const { prompt_cache_key, include, codex, ...rest } = settings;
  const promptCacheKey =
    typeof codex?.promptCacheKey === 'string'
      ? codex.promptCacheKey
      : typeof prompt_cache_key === 'string'
      ? prompt_cache_key
      : undefined;
  const codexInclude = Array.isArray(codex?.include)
    ? codex.include
    : Array.isArray(include)
    ? include.filter((value): value is string => typeof value === 'string')
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
