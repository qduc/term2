import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ExecutionContext } from '../services/execution-context.js';
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

/** Narrow capability interface consumed by chat/session clients. */
export interface AgentSource {
  getAgent(sessionId?: string): ApplicationAgent;
  getProvider(): string;
  getModel(): string;
}

export interface AgentConfigurationDeps {
  logger: ILoggingService;
  settings: ISettingsService;
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
}

export class AgentConfiguration implements AgentSource {
  #agent: ApplicationAgent;
  #model: string;
  #reasoningEffort?: ReasoningEffortSetting | null;
  #temperature?: number;
  #provider: string;
  #isTransientClient: boolean;
  #editor: ReturnType<typeof createEditorImpl>;
  #approvalPolicyRegistry: ToolApprovalPolicyRegistry;

  // Service references (for #buildFactoryDeps)
  // Callback for side effects before rebuild
  #onConfigChanged?: (changedKey?: string) => void;

  #logger: ILoggingService;
  #settings: ISettingsService;
  #executionContext?: ExecutionContext;
  #toolInterceptorRegistry: ToolInterceptorRegistry;
  #askUserAnswerStore: AskUserAnswerStore;
  #getSubagentBridge: () => SubagentBridge | null;
  #serviceTierOverrideForNextRequest: 'standard' | null = null;
  #skillsService?: SkillsService;
  #postExecutePauseCapability?: PostExecutePauseCapability;
  #sessionAccess?: SessionAccessState;
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
  #unsubscribeSettings: (() => void) | null = null;
  #isDisposed = false;

  constructor(
    config: {
      model?: string;
      reasoningEffort?: ReasoningEffortSetting | null;
      temperature?: number;
      providerOverride?: string;
      agentOverride?: ApplicationAgent;
    },
    deps: AgentConfigurationDeps,
  ) {
    // Store deps
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#executionContext = deps.executionContext;
    this.#toolInterceptorRegistry = deps.toolInterceptorRegistry;
    this.#askUserAnswerStore = deps.askUserAnswerStore;
    this.#getSubagentBridge = deps.getSubagentBridge;
    this.#onConfigChanged = deps.onConfigChanged;
    this.#skillsService = deps.skillsService;
    this.#postExecutePauseCapability = deps.postExecutePauseCapability;
    this.#sessionAccess = deps.sessionAccess;
    this.#backgroundShellRegistry = deps.backgroundShellRegistry;
    this.#backgroundShellOutput = deps.backgroundShellOutput;
    this.#shellChildRegistry = deps.shellChildRegistry;
    this.#allowBackgroundShell = deps.allowBackgroundShell ?? true;
    this.#allowAskUser = deps.allowAskUser ?? true;
    this.#sessionBrowser = deps.sessionBrowser;
    this.#requestSessionRollover = deps.requestSessionRollover;
    this.#configureTaskCheckIn = deps.configureTaskCheckIn;
    this.#setTaskCheckInPolicy = deps.setTaskCheckInPolicy;
    this.#approvalPolicyRegistry = new ToolApprovalPolicyRegistry();

    // Create editor
    this.#editor = createEditorImpl({
      loggingService: this.#logger,
      settingsService: this.#settings,
      executionContext: this.#executionContext,
    });

    // Initialize config
    this.#reasoningEffort = config.reasoningEffort;
    this.#temperature = config.temperature ?? this.#settings.get('agent.temperature');
    this.#provider = config.providerOverride ?? this.#settings.get('agent.provider') ?? 'openai';

    if (config.agentOverride) {
      this.#isTransientClient = true;
      this.#agent = config.agentOverride;
      this.#model = config.model ?? (config.agentOverride as any).model ?? '';
    } else {
      this.#isTransientClient = false;
      const buildResult = buildAgent(
        { model: config.model, reasoningEffort: config.reasoningEffort },
        this.#buildFactoryDeps(),
      );
      this.#agent = buildResult.agent;
      this.#model = buildResult.resolvedModel;
    }
  }

  // AgentSource implementation
  getAgent(sessionId?: string): ApplicationAgent {
    if (sessionId && !this.#isTransientClient) {
      const capabilities = getProvider(this.#provider)?.capabilities;
      const supportsPromptCacheKey = capabilities?.supportsPromptCacheKey;
      if (!supportsPromptCacheKey || !sessionId) {
        return this.#agent;
      }
      if (capabilities?.promptCacheKeyPlacement !== 'responses-extra-body') {
        return { ...this.#agent, modelSettings: { ...(this.#agent.modelSettings ?? {}), prompt_cache_key: sessionId } };
      }
      return {
        ...this.#agent,
        modelSettings: {
          ...(this.#agent.modelSettings ?? {}),
          providerData: {
            ...((this.#agent.modelSettings?.providerData as any) ?? {}),
            extraBody: {
              ...((this.#agent.modelSettings?.providerData as any)?.extraBody ?? {}),
              prompt_cache_key: sessionId,
            },
          },
        },
      };
    }
    return this.#agent;
  }

  getProvider(): string {
    return this.#provider;
  }

  getModel(): string {
    return this.#model;
  }

  /**
   * Build the SDK-free agent definition consumed by the application run loop.
   * The legacy SDK Agent remains available to the compatibility path until
   * every provider has moved to the application-owned model boundary.
   */
  getApplicationAgent(sessionId?: string): ApplicationAgent {
    // The agent held by this configuration is already the factory-wrapped
    // application definition. Rebuilding from getAgentDefinition here loses
    // wrapped tool behavior (interceptors, approvals, and post-execute
    // gates), and used to discard transient/override agents altogether.
    const agent = this.getAgent(sessionId);
    if (this.#provider !== 'codex' || !agent.modelSettings) return agent;
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
      executionContext: this.#executionContext,
      editor: this.#editor,
      approvalPolicyRegistry,
      providerId: this.#provider,
      serviceTierOverrideForNextRequest: this.#serviceTierOverrideForNextRequest,
      createMentor: (...args) => this.#getSubagentBridge()!.createMentor(...args),
      runSubagent: (...args) => this.#getSubagentBridge()!.runSubagent(...args),
      runSubagentAsync: (...args) => this.#getSubagentBridge()!.runSubagentAsync(...args),
      getSubagentResult: (...args) => this.#getSubagentBridge()!.getSubagentResult(...args),
      getSubagentStatus: (...args) => this.#getSubagentBridge()!.getSubagentStatus(...args),
      sendSubagentMessage: (...args) => this.#getSubagentBridge()!.sendSubagentMessage(...args),
      cancelSubagentRun: (...args) => this.#getSubagentBridge()!.cancelSubagentRun(...args),
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
      backgroundShellRegistry: this.#backgroundShellRegistry,
      backgroundShellOutput: this.#backgroundShellOutput,
      shellChildRegistry: this.#shellChildRegistry,
      allowBackgroundShell: this.#allowBackgroundShell,
      allowAskUser: this.#allowAskUser,
      sessionBrowser: this.#sessionBrowser,
      ...(this.#requestSessionRollover ? { requestSessionRollover: this.#requestSessionRollover } : {}),
      configureTaskCheckIn: this.#configureTaskCheckIn,
      setTaskCheckInPolicy: this.#setTaskCheckInPolicy,
    };
  }

  // Expose buildFactoryDeps for AgentClient to use
  getBuildFactoryDeps(): AgentFactoryDeps {
    return this.#buildFactoryDeps();
  }

  get approvalPolicyRegistry(): ToolApprovalPolicyRegistry {
    return this.#approvalPolicyRegistry;
  }

  // Rebuild the agent with current config
  rebuildAgent(): void {
    if (this.#isTransientClient) return;
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    const buildResult = buildAgent(
      {
        model: this.#model,
        reasoningEffort: this.#reasoningEffort as any,
        temperature: this.#temperature,
      },
      this.#buildFactoryDeps(approvalPolicyRegistry),
    );
    this.#agent = buildResult.agent;
    this.#model = buildResult.resolvedModel;
    this.#approvalPolicyRegistry = approvalPolicyRegistry;
  }

  /** Subscribe to settings changes that affect agent definition and rebuild automatically. */
  subscribeToSettings(): void {
    if (this.#isTransientClient || this.#isDisposed || this.#unsubscribeSettings) return;

    const rebuildKeys = [
      'app.activeProfileId',
      'enable_agent_workflow',
      'app.searchViaShell',
      'agent.model',
      'agent.provider',
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
      'agent.smartProvider',
      'agent.balancedModel',
      'agent.balancedProvider',
      'agent.cheapModel',
      'agent.cheapProvider',
      'agent.choreModel',
      'agent.choreProvider',
      'agent.mentorModel',
      'agent.mentorProvider',
      'agent.mentorReasoningEffort',
      'agent.subagentExplorerModel',
      'agent.subagentWorkerModel',
      'agent.subagentExplorerProvider',
      'agent.subagentWorkerProvider',
      'agent.subagentExplorerReasoningEffort',
      'agent.subagentWorkerReasoningEffort',
      'agent.subagentLibrarianModel',
      'agent.subagentLibrarianProvider',
      'agent.subagentLibrarianReasoningEffort',
      'logging.logLevel',
      'logging.suppressConsoleOutput',
      'shell.useRtkCompression',
    ];

    if (typeof this.#settings.onChange !== 'function') return;

    this.#unsubscribeSettings = this.#settings.onChange((changedKey) => {
      if (this.#isDisposed) return;
      if (!changedKey) return;
      if (rebuildKeys.includes(changedKey)) {
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

  setModel(model: string): void {
    this.#model = model;
  }

  setReasoningEffort(effort?: ReasoningEffortSetting): void {
    this.#reasoningEffort = effort;
  }

  setTemperature(temperature?: number): void {
    this.#temperature = temperature;
  }

  setProvider(provider: string): void {
    this.#provider = provider;
    this.#settings.set('agent.provider', provider);
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
