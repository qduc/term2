import type { Agent } from '@openai/agents';
import { type ModelSettingsReasoningEffort } from '@openai/agents-core/model';
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

/** Narrow capability interface consumed by AgentRunOrchestrator and AgentChatService. */
export interface AgentSource {
  getAgent(sessionId?: string): Agent;
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
}

export class AgentConfiguration implements AgentSource {
  #agent: Agent;
  #model: string;
  #reasoningEffort?: ModelSettingsReasoningEffort | 'default';
  #temperature?: number;
  #provider: string;
  #isTransientClient: boolean;
  #editor: ReturnType<typeof createEditorImpl>;

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

  constructor(
    config: {
      model?: string;
      reasoningEffort?: ModelSettingsReasoningEffort | 'default';
      temperature?: number;
      providerOverride?: string;
      agentOverride?: Agent;
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

    // Create editor
    this.#editor = createEditorImpl({
      loggingService: this.#logger,
      settingsService: this.#settings,
      executionContext: this.#executionContext,
    });

    // Initialize config
    this.#reasoningEffort = config.reasoningEffort;
    this.#temperature = config.temperature ?? this.#settings.get<number | undefined>('agent.temperature');
    this.#provider = config.providerOverride ?? this.#settings.get<string>('agent.provider') ?? 'openai';

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
  getAgent(sessionId?: string): Agent {
    if (sessionId && !this.#isTransientClient) {
      const supportsPromptCacheKey = getProvider(this.#provider)?.capabilities?.supportsPromptCacheKey;
      if (!supportsPromptCacheKey || !sessionId) {
        return this.#agent;
      }
      return this.#agent.clone({
        modelSettings: {
          ...(this.#agent.modelSettings || {}),
          prompt_cache_key: sessionId,
        } as any,
      });
    }
    return this.#agent;
  }

  getProvider(): string {
    return this.#provider;
  }

  getModel(): string {
    return this.#model;
  }

  // Build the factory deps (used by buildAgent and for agent rebuilds)
  #buildFactoryDeps(): AgentFactoryDeps {
    return {
      settings: this.#settings,
      logger: this.#logger,
      executionContext: this.#executionContext,
      editor: this.#editor,
      providerId: this.#provider,
      serviceTierOverrideForNextRequest: this.#serviceTierOverrideForNextRequest,
      createMentor: (...args) => this.#getSubagentBridge()!.createMentor(...args),
      runSubagent: (...args) => this.#getSubagentBridge()!.runSubagent(...args),
      getAskUserAnswer: (callId?: string) => {
        if (!callId) return undefined;
        return this.#askUserAnswerStore.consume(callId);
      },
      checkToolInterceptors: (name, params, toolCallId) =>
        this.#toolInterceptorRegistry.check(name, params, toolCallId),
      skillsService: this.#skillsService,
      getAgentRuntime: () => ({
        agent: (config) => {
          const runtime = this.#getSubagentBridge()?.getAgentRuntime();
          if (!runtime) throw new Error('Agent runtime is unavailable');
          return runtime.agent(config);
        },
      }),
    };
  }

  // Expose buildFactoryDeps for AgentClient to use
  getBuildFactoryDeps(): AgentFactoryDeps {
    return this.#buildFactoryDeps();
  }

  // Rebuild the agent with current config
  rebuildAgent(): void {
    if (this.#isTransientClient) return;
    const buildResult = buildAgent(
      {
        model: this.#model,
        reasoningEffort: this.#reasoningEffort as any,
        temperature: this.#temperature,
      },
      this.#buildFactoryDeps(),
    );
    this.#agent = buildResult.agent;
    this.#model = buildResult.resolvedModel;
  }

  /** Subscribe to settings changes that affect agent definition and rebuild automatically. */
  subscribeToSettings(): void {
    if (this.#isTransientClient) return;

    const rebuildKeys = [
      'app.liteMode',
      'app.orchestratorMode',
      'app.planMode',
      'app.mentorMode',
      'enable_agent_workflow',
      'app.searchViaShell',
      'agent.model',
      'agent.provider',
      'agent.transport',
      'agent.retryAttempts',
      'agent.reasoningEffort',
      'agent.temperature',
      'agent.useFlexServiceTier',
      'agent.mentorModel',
      'agent.mentorProvider',
      'agent.mentorReasoningEffort',
      'agent.subagentExplorerModel',
      'agent.subagentWorkerModel',
      'agent.subagentResearcherModel',
      'agent.subagentExplorerProvider',
      'agent.subagentWorkerProvider',
      'agent.subagentResearcherProvider',
      'agent.subagentExplorerReasoningEffort',
      'agent.subagentWorkerReasoningEffort',
      'agent.subagentResearcherReasoningEffort',
      'logging.logLevel',
      'logging.suppressConsoleOutput',
      'shell.useRtkCompression',
    ];

    this.#settings.onChange?.((changedKey) => {
      if (!changedKey) return;
      if (rebuildKeys.includes(changedKey)) {
        this.#onConfigChanged?.(changedKey);
        this.rebuildAgent();
      }
    });
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

  setReasoningEffort(effort?: ModelSettingsReasoningEffort | 'default'): void {
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
    return this.#settings.get<number | undefined>('agent.maxTurns') ?? 20;
  }
}
