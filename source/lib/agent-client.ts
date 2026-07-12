import {
  Agent,
  type AgentInputItem,
  type JsonSchemaDefinition,
  type RunState,
  type StreamedRunResult,
} from '@openai/agents';
import { type ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ExecutionContext } from '../services/execution-context.js';
import { AskUserAnswerStore } from './ask-user-answer-store.js';
import { AgentConfiguration } from './agent-configuration.js';
import { SkillsService } from '../services/skills/skills-service.js';

import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import { SubagentBridge } from './subagent-bridge.js';
import { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import { RunnerManager } from './runner-manager.js';
import { AgentRunOrchestrator } from './agent-run-orchestrator.js';
import { AgentChatService } from './agent-chat-service.js';

type ChainedRunOptions = {
  previousResponseId?: string | null;
  sessionId?: string;
  toolResultCallIds?: readonly string[];
};

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class AgentClient {
  #agentConfig: AgentConfiguration;
  #runnerManager: RunnerManager;
  #toolInterceptorRegistry: ToolInterceptorRegistry;
  #runOrchestrator: AgentRunOrchestrator;
  #chatService: AgentChatService;
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #subagentBridge: SubagentBridge | null = null;
  #askUserAnswerStore: AskUserAnswerStore;

  /**
   * Forward real-time subagent activity events to the active conversation
   * turn. The session sets this for the duration of a send and clears it
   * afterwards so events reach the UI's onEvent callback.
   */
  setSubagentEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    this.#subagentBridge?.setEventSink(sink);
  }

  #resetMentorState(): void {
    this.#subagentBridge?.clearSubagentCache();
  }

  constructor({
    model,
    reasoningEffort,
    maxTurns,
    retryAttempts,
    agentOverride,
    providerOverride,
    deps,
    subagentBridge,
  }: {
    model?: string;
    reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    maxTurns?: number;
    retryAttempts?: number;
    agentOverride?: Agent;
    providerOverride?: string;
    deps: {
      logger: ILoggingService;
      settings: ISettingsService;
      executionContext?: ExecutionContext;
      sessionContextService: ISessionContextService;
      skillsService?: SkillsService;
    };
    /** Test seam: inject a pre-built SubagentBridge instead of creating one. */
    subagentBridge?: SubagentBridge;
  }) {
    this.#logger = deps.logger;
    this.#toolInterceptorRegistry = new ToolInterceptorRegistry({ logger: this.#logger });
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#askUserAnswerStore = new AskUserAnswerStore();

    // Create AgentConfiguration (handles editor, model, provider, reasoning, etc.)
    this.#agentConfig = new AgentConfiguration(
      { model, reasoningEffort, providerOverride, agentOverride },
      {
        logger: deps.logger,
        settings: deps.settings,
        sessionContextService: deps.sessionContextService,
        executionContext: deps.executionContext,
        toolInterceptorRegistry: this.#toolInterceptorRegistry,
        askUserAnswerStore: this.#askUserAnswerStore,
        getSubagentBridge: () => this.#subagentBridge,
        skillsService: deps.skillsService,
        onConfigChanged: (changedKey?: string) => {
          // Runner invalidation for specific keys
          if (changedKey === 'agent.transport' || changedKey === 'agent.retryAttempts') {
            this.#runnerManager.invalidateRunner();
          }
          // Always clear subagent cache and reset mentor state
          this.#subagentBridge?.clearCache();
          this.#resetMentorState();
        },
      },
    );

    this.#runnerManager = new RunnerManager(
      {
        maxTurns: maxTurns ?? (agentOverride ? 1 : 20),
        retryAttempts: retryAttempts ?? 2,
      },
      {
        settings: deps.settings,
        logger: deps.logger,
        sessionContextService: deps.sessionContextService ?? this.#sessionContextService,
        getProvider: () => this.#agentConfig.getProvider(),
      },
    );

    this.#runOrchestrator = new AgentRunOrchestrator({
      agentConfig: this.#agentConfig,
      runnerManager: this.#runnerManager,
      settings: deps.settings,
      logger: deps.logger,
    });

    this.#chatService = new AgentChatService({
      agentConfig: this.#agentConfig,
      runnerManager: this.#runnerManager,
      settings: deps.settings,
      logger: deps.logger,
    });

    if (subagentBridge) {
      this.#subagentBridge = subagentBridge;
    } else if (!agentOverride) {
      this.#subagentBridge = new SubagentBridge({
        logger: deps.logger,
        settings: deps.settings,
        executionContext: deps.executionContext,
        sessionContextService: this.#sessionContextService,
        chat: (message, options) => this.chat(message, options),
        // Factory lives here (not in SubagentBridge) so each subagent gets a
        // lightweight transient client that shares logger/settings/executionContext
        // with the parent but skips agent-rebuild and SubagentManager initialisation.
        createClient: ({
          agent,
          provider,
          maxTurns,
          retryAttempts,
        }: {
          agent: any;
          provider: string;
          maxTurns: number;
          retryAttempts?: number;
        }) =>
          new AgentClient({
            model: agent.model,
            maxTurns,
            retryAttempts,
            deps: {
              logger: deps.logger,
              settings: deps.settings,
              executionContext: deps.executionContext,
              sessionContextService: this.#sessionContextService,
              skillsService: deps.skillsService,
            },
            agentOverride: agent,
            providerOverride: provider,
          }),
        skillsService: deps.skillsService,
      });
    }

    if (!agentOverride) {
      // Subscribe to settings changes via AgentConfiguration
      this.#agentConfig.subscribeToSettings();

      this.#logger.debug('OpenAI Agent Client initialized', {
        model: model || this.#settings.get<string>('agent.model'),
        reasoningEffort: reasoningEffort ?? 'default',
        temperature: this.#agentConfig.temperature,
        maxTurns: this.#runnerManager.maxTurns,
        retryAttempts: this.#runnerManager.retryAttempts,
      });
    }
  }

  setModel(model: string): void {
    this.#agentConfig.setModel(model);
    this.#agentConfig.refreshAgent();
  }

  setReasoningEffort(effort?: ModelSettingsReasoningEffort | 'default'): void {
    this.#agentConfig.setReasoningEffort(effort);
    this.#agentConfig.refreshAgent();
  }

  setTemperature(temperature?: number): void {
    this.#agentConfig.setTemperature(temperature);
    this.#agentConfig.refreshAgent();
  }

  setProvider(provider: string): void {
    this.#agentConfig.setProvider(provider); // persists to settings
    this.#agentConfig.refreshAgent(); // triggers onConfigChanged + rebuild
    this.#runnerManager.invalidateRunner();
  }

  getProvider(): string {
    return this.#agentConfig.getProvider();
  }

  supportsConversationChaining(): boolean {
    return this.#runOrchestrator.supportsConversationChaining();
  }

  setAskUserAnswer(callId: string, answer: string): void {
    this.#askUserAnswerStore.set(callId, answer);
  }

  getAskUserAnswer(callId?: string): string | undefined {
    if (!callId) return undefined;
    return this.#askUserAnswerStore.consume(callId);
  }

  addToolInterceptor(
    interceptor: (name: string, params: any, toolCallId?: string) => Promise<string | null>,
  ): () => void {
    return this.#toolInterceptorRegistry.add(interceptor);
  }

  useStandardServiceTierForNextRequest(): void {
    this.#agentConfig.serviceTierOverrideForNextRequest = 'standard';
    this.#agentConfig.refreshAgent();
  }

  setRetryCallback(callback: () => void): void {
    this.#runnerManager.setRetryCallback(callback);
  }

  /**
   * Abort the current running stream/operation
   */
  abort(): void {
    this.#runOrchestrator.abort();
    this.#subagentBridge?.abort();
  }

  clearConversations(): void {
    this.#runOrchestrator.clearConversations();
  }

  async startStream(
    userInput: string | AgentInputItem | AgentInputItem[],
    options: ChainedRunOptions = {},
  ): Promise<StreamedRunResult<any, any>> {
    this.#subagentBridge?.resetAbortController();
    return this.#runOrchestrator.startStream(userInput, options);
  }

  async continueRunStream(
    state: RunState<any, any>,
    options: ChainedRunOptions = {},
  ): Promise<StreamedRunResult<any, any>> {
    this.#subagentBridge?.resetAbortController();
    return this.#runOrchestrator.continueRunStream(state, options);
  }

  async chat(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ModelSettingsReasoningEffort | 'default';
      instructions?: string;
    } = {},
  ): Promise<string> {
    return this.#chatService.chat(message, options);
  }

  async chatJson(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ModelSettingsReasoningEffort | 'default';
      instructions?: string;
      outputType: JsonSchemaDefinition;
    },
  ): Promise<unknown> {
    return this.#chatService.chatJson(message, options);
  }

  getSettings(): ISettingsService {
    return this.#settings;
  }
}
