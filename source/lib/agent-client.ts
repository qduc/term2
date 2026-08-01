import type { ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import type { ContinuationHandle } from '../contracts/continuation-handle.js';
import { unwrapContinuationHandle } from '../contracts/continuation-handle.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { JsonSchemaDefinition } from '../contracts/model-types.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ExecutionContext } from '../services/execution-context.js';
import { AskUserAnswerStore } from './ask-user-answer-store.js';
import { AgentConfiguration } from './agent-configuration.js';
import { SkillsService } from '../services/skills/skills-service.js';

import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import { SubagentBridge } from './subagent-bridge.js';
import { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import { RunnerManager } from './runner-manager.js';
import { AgentRunOrchestrator, type AgentRunOrchestratorDeps } from './agent-run-orchestrator.js';
import { AgentChatService } from './agent-chat-service.js';
import type { ContinuationProjectionMode } from './continuation-projection-mode.js';
import type { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { PostExecutePauseCapability } from '../tools/types.js';
import type { SessionAccessState } from '../services/session/session-access-state.js';
import type { AgentClientRunOptions } from '../services/conversation-agent-client.js';
import { adaptAgentStream, type AgentStream } from '../services/agent-stream.js';
import type { ProviderInput } from '../contracts/provider-input.js';
import type { ProviderRequestCapture } from '../providers/provider-request-capture.js';
import { getProvider } from '../providers/index.js';
import { ApplicationRunLoop } from '../services/agent-runtime/application-run-loop.js';

type ChainedRunOptions = AgentClientRunOptions;

/**
 * Conversation client over the application-owned provider/run-loop boundary.
 */
export class AgentClient {
  #agentConfig: AgentConfiguration;
  #runnerManager: RunnerManager;
  #toolInterceptorRegistry: ToolInterceptorRegistry;
  #runOrchestrator: AgentRunOrchestrator;
  #applicationRunLoop: ApplicationRunLoop;
  #useApplicationRunLoop: boolean;
  #chatService: AgentChatService;
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #subagentBridge: SubagentBridge | null = null;
  #askUserAnswerStore: AskUserAnswerStore;
  #isDisposed = false;

  /**
   * Forward real-time subagent activity events to the active conversation
   * turn. The session sets this for the duration of a send and clears it
   * afterwards so events reach the UI's onEvent callback.
   */
  setSubagentEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    this.#subagentBridge?.setEventSink(sink);
  }

  /**
   * Forward subagent activity events to a conversation-scoped consumer that
   * stays attached across turns. Used to observe background (async) subagent
   * runs that settle while no turn is in flight.
   */
  setBackgroundSubagentEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    this.#subagentBridge?.setBackgroundEventSink(sink);
  }

  /** @deprecated Ordinary turn completion must not cancel background runs. */
  cancelSubagentRuns(): void {
    // Retained for the conversation adapter compatibility surface.
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
    toolOwnership,
    postExecutePauseCapability,
    sessionAccess,
    continuationProjectionMode = 'legacy',
  }: {
    model?: string;
    reasoningEffort?: ReasoningEffortSetting | null;
    maxTurns?: number;
    retryAttempts?: number;
    agentOverride?: ApplicationAgent;
    providerOverride?: string;
    deps: {
      logger: ILoggingService;
      settings: ISettingsService;
      executionContext?: ExecutionContext;
      sessionContextService: ISessionContextService;
      skillsService?: SkillsService;
      /** Supplied only by an owned root session client. */
      requestCapture?: ProviderRequestCapture;
      /** Test seam for inspecting the immutable run-orchestrator dependencies. */
      createRunOrchestrator?: (orchestratorDeps: AgentRunOrchestratorDeps) => AgentRunOrchestrator;
    };
    /** Test seam: inject a pre-built SubagentBridge instead of creating one. */
    subagentBridge?: SubagentBridge;
    /** Session-owned registry shared by approval and nested subagent paths. */
    toolOwnership: ToolOwnershipRegistry;
    /** Root-session-only capability for selected post-execute gates. */
    postExecutePauseCapability?: PostExecutePauseCapability;
    /** Handle-owned state for root read and Docker capabilities. */
    sessionAccess?: SessionAccessState;
    /** Compatibility selection fixed by the owning session handle. */
    continuationProjectionMode?: ContinuationProjectionMode;
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
        postExecutePauseCapability,
        sessionAccess,
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
    this.#useApplicationRunLoop =
      !agentOverride && Boolean(getProvider(this.#agentConfig.getProvider())?.createStreamedModel);
    this.#applicationRunLoop = new ApplicationRunLoop({
      resolveModel: (selectedModel) => {
        const provider = getProvider(this.#agentConfig.getProvider());
        if (!provider?.createStreamedModel) {
          throw new Error(`Provider '${this.#agentConfig.getProvider()}' has no application model`);
        }
        return provider.createStreamedModel(selectedModel, {
          settingsService: deps.settings,
          loggingService: deps.logger,
          sessionContextService: deps.sessionContextService,
          requestCapture: deps.requestCapture,
        });
      },
    });

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
        requestCapture: deps.requestCapture,
      },
    );

    const runOrchestratorDeps: AgentRunOrchestratorDeps = {
      agentConfig: this.#agentConfig,
      runnerManager: this.#runnerManager,
      settings: deps.settings,
      logger: deps.logger,
      continuationProjectionMode,
    };
    this.#runOrchestrator =
      deps.createRunOrchestrator?.(runOrchestratorDeps) ?? new AgentRunOrchestrator(runOrchestratorDeps);

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
            toolOwnership,
          }),
        skillsService: deps.skillsService,
        toolOwnership,
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

  setReasoningEffort(effort?: ReasoningEffortSetting): void {
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
   * Abort the current running stream/operation, including the foreground
   * subagent work of the running turn. Conversation-bound background (async)
   * subagent runs are unaffected — see {@link cancelBackgroundRuns}.
   */
  abort(): void {
    this.#applicationRunLoop.abort();
    this.#runOrchestrator.abort();
    this.#subagentBridge?.abort();
  }

  /**
   * Cancel conversation-bound background (async) subagent runs. Reserved for an
   * explicit user interrupt, conversation disposal, or shutdown.
   */
  cancelBackgroundRuns(): void {
    this.#subagentBridge?.cancelBackgroundRuns();
  }

  /** End all session-bound activity and release resources held by this client. */
  dispose(): void {
    if (this.#isDisposed) return;
    this.#isDisposed = true;

    this.abort();
    this.#runnerManager.invalidateRunner();
    this.#subagentBridge?.dispose();
    this.#agentConfig.dispose();
  }

  clearConversations(): void {
    this.#applicationRunLoop.abort();
    this.#runOrchestrator.clearConversations();
  }

  async startStream(userInput: ProviderInput, options: ChainedRunOptions = {}): Promise<AgentStream> {
    this.#subagentBridge?.resetAbortController();
    if (this.#useApplicationRunLoop) {
      return this.#applicationRunLoop.startStream(this.#agentConfig.getApplicationAgent(), userInput, {
        sessionId: options.sessionId,
        // The turn budget the SDK runner used to enforce. Without it the loop
        // runs unbounded, and subagents silently ignore their maxTurns.
        maxTurns: this.#runnerManager.maxTurns,
      });
    }
    return adaptAgentStream(await this.#runOrchestrator.startStream(userInput as any, options));
  }

  async continueRunStream(state: ContinuationHandle, options: ChainedRunOptions = {}): Promise<AgentStream> {
    this.#subagentBridge?.resetAbortController();
    if (this.#useApplicationRunLoop) {
      return this.#applicationRunLoop.continueRunStream(state, {
        sessionId: options.sessionId,
        maxTurns: this.#runnerManager.maxTurns,
      });
    }
    const rawState = state?.kind === 'continuation' ? unwrapContinuationHandle(state) : state;
    return adaptAgentStream(await this.#runOrchestrator.continueRunStream(rawState as any, options));
  }

  async chat(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ReasoningEffortSetting | null;
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
      reasoningEffort?: ReasoningEffortSetting | null;
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
