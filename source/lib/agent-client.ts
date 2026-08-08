import {
  normalizeApplicationInput,
  type ApplicationAgent,
  type ApplicationRequestPreparation,
  type SteerOutcome,
} from '../services/agent-runtime/application-run-loop.js';
import type { ContinuationHandle } from '../contracts/continuation-handle.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { JsonSchemaDefinition } from '../contracts/model-types.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ExecutionContext } from '../services/execution-context.js';
import { AskUserAnswerStore } from './ask-user-answer-store.js';
import { AgentConfiguration } from './agent-configuration.js';
import { SkillsService } from '../services/skills/skills-service.js';

import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import type { ContextCompactionSessionState } from '../contracts/streamed-model-turn.js';
import { SubagentBridge } from './subagent-bridge.js';
import { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import { AgentChatService } from './agent-chat-service.js';
import type { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { PostExecutePauseCapability, ToolExecutionLifecyclePort } from '../tools/types.js';
import type { Term2HookScope } from '../services/hooks/hook-contracts.js';
import type { SessionAccessState } from '../services/session/session-access-state.js';
import type { AgentClientRunOptions } from '../services/conversation-agent-client.js';
import type { ContinuationProjectionMode } from './continuation-projection-mode.js';
import type { AgentStream } from '../services/agent-stream.js';
import type { ProviderInput, ProviderInputItem } from '../contracts/provider-input.js';
import type { ProviderRequestCapture } from '../providers/provider-request-capture.js';
import { getProvider } from '../providers/index.js';
import { ApplicationRunLoop } from '../services/agent-runtime/application-run-loop.js';
import { randomUUID } from 'node:crypto';
import { fetchModels } from '../services/model-service.js';
import {
  prepareOpenAIRequestPrefixBinding,
  runWithOpenAIRequestPrefixBindingScope,
} from '../providers/openai-request-prefix-binding.js';
import { isDeepStrictEqual } from 'node:util';
import {
  type BackgroundShellEvent,
  type BackgroundShellRegistry,
} from '../services/shell/background-shell-registry.js';
import type { BackgroundShellExecutionResult } from '../tools/system/shell.js';

type ChainedRunOptions = AgentClientRunOptions;

function createScopedToolLifecycle(
  lifecycle: ToolExecutionLifecyclePort,
  scope: { agentId: string; role: string },
): ToolExecutionLifecyclePort {
  const withScope = (context: Parameters<ToolExecutionLifecyclePort['before']>[0]) => ({
    ...context,
    scope: { subagent: scope },
  });
  return {
    before: (context) => lifecycle.before(withScope(context)),
    after: (context, result, duration) => lifecycle.after(withScope(context), result, duration),
    error: (context, error, duration, convertedToModelResult) =>
      lifecycle.error(withScope(context), error, duration, convertedToModelResult),
  };
}

/**
 * Conversation client over the application-owned provider/run-loop boundary.
 */
export class AgentClient {
  #agentConfig: AgentConfiguration;
  #toolInterceptorRegistry: ToolInterceptorRegistry;
  #applicationRunLoop: ApplicationRunLoop;
  #contextCompactionSessionState: ContextCompactionSessionState = { disabled: false };
  #maxTurns: number;
  #retryAttempts: number;
  #retryCallback: (() => void) | null = null;
  #currentCorrelationId: string | null = null;
  #activeStartController: AbortController | null = null;
  #chatService: AgentChatService;
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #subagentBridge: SubagentBridge | null = null;
  #askUserAnswerStore: AskUserAnswerStore;
  #isDisposed = false;
  #toolLifecycle?: ToolExecutionLifecyclePort;
  #hookScope: Term2HookScope = 'root';
  #backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;

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

  /** Route root shell-job lifecycle through the durable conversation sink. */
  setBackgroundShellEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    this.#backgroundShellRegistry?.setEventSink(
      sink ? (event) => sink(backgroundShellEventToConversationEvent(event)) : undefined,
    );
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
    toolLifecycle,
    hookScope,
    backgroundShellRegistry,
    allowBackgroundShell = true,
    // Retained for session-factory compatibility; direct execution no longer
    // projects chained input through the legacy mode.
    continuationProjectionMode: _continuationProjectionMode = 'legacy',
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
    };
    /** Test seam: inject a pre-built SubagentBridge instead of creating one. */
    subagentBridge?: SubagentBridge;
    /** Session-owned registry shared by approval and nested subagent paths. */
    toolOwnership: ToolOwnershipRegistry;
    /** Root-session-only capability for selected post-execute gates. */
    postExecutePauseCapability?: PostExecutePauseCapability;
    /** Handle-owned state for root read and Docker capabilities. */
    sessionAccess?: SessionAccessState;
    /** Root-only observational lifecycle port; omitted for nested clients. */
    toolLifecycle?: ToolExecutionLifecyclePort;
    hookScope?: Term2HookScope;
    /** Root-session-owned shell registry. Nested clients deliberately omit it. */
    backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;
    /** False for one-shot/non-interactive callers until their lifecycle is supported. */
    allowBackgroundShell?: boolean;
    continuationProjectionMode?: ContinuationProjectionMode;
  }) {
    this.#logger = deps.logger;
    this.#toolInterceptorRegistry = new ToolInterceptorRegistry({ logger: this.#logger });
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#toolLifecycle = toolLifecycle;
    this.#hookScope = hookScope ?? 'root';
    this.#backgroundShellRegistry = allowBackgroundShell ? backgroundShellRegistry : undefined;
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
        backgroundShellRegistry: this.#backgroundShellRegistry,
        allowBackgroundShell,
        onConfigChanged: (_changedKey?: string) => {
          // Direct streamed models capture provider/settings at creation time.
          // Chat models are separately cached below.
          this.#chatService?.clearModelCache();
          // Always clear subagent cache and reset mentor state
          this.#subagentBridge?.clearCache();
          this.#resetMentorState();
        },
      },
    );
    this.#maxTurns = maxTurns ?? (agentOverride ? 1 : 20);
    this.#retryAttempts = retryAttempts ?? 2;
    this.#applicationRunLoop = new ApplicationRunLoop({
      toolLifecycle: this.#toolLifecycle,
      contextCompactionSessionState: this.#contextCompactionSessionState,
      logDiagnostic: (message, meta) => deps.logger.info(message, meta),
      resolveModel: (selectedModel) => {
        const providerId = this.#agentConfig.getProvider();
        const provider = getProvider(providerId);
        if (!provider?.createStreamedModel) {
          throw new Error(`Provider '${providerId}' does not expose an application streamed model.`);
        }
        return provider.createStreamedModel(selectedModel, {
          settingsService: deps.settings,
          loggingService: deps.logger,
          sessionContextService: deps.sessionContextService,
          onRetry: () => this.#retryCallback?.(),
          retryAttempts: this.#retryAttempts,
          requestCapture: deps.requestCapture,
          contextCompactionSessionState: this.#contextCompactionSessionState,
        });
      },
    });
    this.#chatService = new AgentChatService({
      agentConfig: this.#agentConfig,
      settings: deps.settings,
      logger: deps.logger,
      sessionContextService: this.#sessionContextService,
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
          agentId,
          role,
        }: {
          agent: any;
          provider: string;
          maxTurns: number;
          retryAttempts?: number;
          agentId?: string;
          role?: string;
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
            ...(this.#toolLifecycle && agentId
              ? {
                  toolLifecycle: createScopedToolLifecycle(this.#toolLifecycle, {
                    agentId,
                    role: role ?? agent.name,
                  }),
                  hookScope: { subagent: { agentId, role: role ?? agent.name } },
                }
              : {}),
          }),
        skillsService: deps.skillsService,
        toolOwnership,
      });
    }

    if (!agentOverride) {
      // Subscribe to settings changes via AgentConfiguration
      this.#agentConfig.subscribeToSettings();

      this.#logger.debug('OpenAI Agent Client initialized', {
        model: model || this.#settings.get('agent.model'),
        reasoningEffort: reasoningEffort ?? 'default',
        temperature: this.#agentConfig.temperature,
        maxTurns: this.#maxTurns,
        retryAttempts: this.#retryAttempts,
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
    this.#chatService.clearModelCache();
  }

  getProvider(): string {
    return this.#agentConfig.getProvider();
  }

  supportsConversationChaining(): boolean {
    return getProvider(this.#agentConfig.getProvider())?.capabilities?.supportsConversationChaining ?? false;
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
    this.#retryCallback = callback;
  }

  /**
   * Abort the current running stream/operation, including the foreground
   * subagent work of the running turn. Conversation-bound background (async)
   * subagent runs are unaffected — see {@link cancelBackgroundRuns}.
   */
  abort(): void {
    this.#abortActiveWork(() => this.#applicationRunLoop.abort());
  }

  /**
   * Stop whatever is streaming, deciding only whether the turn dies with it.
   *
   * Resuming a paused turn passes through here too, and must not take the
   * turn's injections down: they are waiting for the very segment about to
   * start. Only a caller that means to end the turn discards them.
   */
  #abortActiveWork(abortRunLoop: () => void): void {
    const traceId = this.#currentCorrelationId ?? this.#logger.getCorrelationId?.();
    this.#activeStartController?.abort();
    this.#activeStartController = null;
    abortRunLoop();
    this.#clearCorrelationId();
    this.#logger.debug('Agent operation aborted', {
      eventType: 'stream.aborted',
      category: 'stream',
      phase: 'abort',
      traceId,
    });
    this.#chatService.abort();
    this.#subagentBridge?.abort();
  }

  /**
   * Mark the boundaries of a turn for the run loop, which otherwise sees only
   * the individual streams a turn is made of and cannot tell its first stream
   * from a retry of its last. Called by the component that owns turn identity
   * (`TurnCoordinator`); a caller that drives streams directly may skip them
   * and keep the stream-scoped behaviour.
   */
  openTurn(): void {
    this.#applicationRunLoop.openTurn();
  }

  closeTurn(): void {
    this.#applicationRunLoop.closeTurn();
  }

  /**
   * Hand the running turn a user message for its next model request. Resolves
   * `'released'` when the turn offers no further request boundary, leaving the
   * caller to send the message as its own turn.
   */
  steer(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<SteerOutcome> {
    return this.#applicationRunLoop.steer(items, options);
  }

  /** Drop a still-waiting steer. False when it was already admitted. */
  retractSteer(id: string): boolean {
    return this.#applicationRunLoop.retractSteer(id);
  }

  /** Replace a waiting steer's items in place, keeping its position. */
  editSteer(id: string, items: readonly ProviderInputItem[]): boolean {
    return this.#applicationRunLoop.editSteer(id, items);
  }

  /**
   * Cancel conversation-bound background (async) subagent runs. Reserved for an
   * explicit user interrupt, conversation disposal, or shutdown.
   */
  cancelBackgroundRuns(): void {
    this.#subagentBridge?.cancelBackgroundRuns();
  }

  cancelBackgroundShellJobs(): void {
    for (const job of this.#backgroundShellRegistry?.list() ?? []) {
      this.#backgroundShellRegistry?.cancel(job.id);
    }
  }

  disposeBackgroundShellJobs(): Promise<void> {
    return this.#backgroundShellRegistry?.dispose() ?? Promise.resolve();
  }

  /** End all session-bound activity and release resources held by this client. */
  dispose(): void {
    if (this.#isDisposed) return;
    this.#isDisposed = true;

    this.abort();
    void this.disposeBackgroundShellJobs();
    this.#chatService.clearModelCache();
    this.#subagentBridge?.dispose();
    this.#agentConfig.dispose();
  }

  clearConversations(): void {
    this.#applicationRunLoop.abort();
    getProvider(this.#agentConfig.getProvider())?.clearConversations?.();
    this.#agentConfig.refreshAgent();
    this.#logger.debug('Conversation and agent refreshed');
  }

  #clearCorrelationId(): void {
    if (this.#currentCorrelationId) {
      this.#logger.clearCorrelationId();
      this.#currentCorrelationId = null;
    }
  }

  async #prepareStart(userInput: ProviderInput, options: ChainedRunOptions, signal: AbortSignal): Promise<void> {
    let agentRefreshed = false;
    if (this.#agentConfig.getProvider() === 'codex' && this.#settings.get('agent.reasoningEffort') === 'default') {
      try {
        await fetchModels({ settingsService: this.#settings, loggingService: this.#logger, signal }, 'codex');
        if (signal.aborted) throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
        this.#agentConfig.refreshAgent();
        agentRefreshed = true;
      } catch {
        // Model discovery is best effort; the provider can still resolve its default.
      }
    }
    if (signal.aborted) throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
    const isFirstMessage =
      !options.previousResponseId && (!Array.isArray(userInput) || (userInput.length > 0 && userInput.length <= 1));
    if (isFirstMessage && !agentRefreshed) this.#agentConfig.refreshAgent();

    this.#currentCorrelationId = randomUUID();
    this.#logger.setCorrelationId(this.#currentCorrelationId);
    this.#logger.debug('Agent stream started', {
      eventType: 'provider.request.started',
      category: 'provider',
      phase: 'request_start',
      traceId: this.#currentCorrelationId,
      provider: this.#agentConfig.getProvider(),
      model: this.#agentConfig.getModel(),
      inputType: Array.isArray(userInput) ? 'array' : typeof userInput,
      inputLength: typeof userInput === 'string' ? userInput.length : undefined,
      inputItems: Array.isArray(userInput) ? userInput.length : undefined,
      messages: Array.isArray(userInput) ? userInput : undefined,
      hasPreviousResponseId: !!options.previousResponseId,
    });
  }

  #observeCompletion(stream: AgentStream, input: unknown, provider: string, model: string): void {
    const correlationId = this.#currentCorrelationId;
    const cleanup = () => {
      if (this.#agentConfig.serviceTierOverrideForNextRequest === 'standard') {
        this.#agentConfig.serviceTierOverrideForNextRequest = null;
        this.#agentConfig.refreshAgent();
      }
      if (this.#currentCorrelationId === correlationId) this.#clearCorrelationId();
    };
    void stream.completed.then(
      () => cleanup(),
      (error) => {
        this.#logger.error('Agent stream failed', {
          eventType: 'provider.response.failed',
          category: 'provider',
          phase: 'provider_response',
          traceId: correlationId,
          provider,
          model,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          inputType: Array.isArray(input) ? 'array' : typeof input,
          inputLength: typeof input === 'string' ? input.length : undefined,
          inputItems: Array.isArray(input) ? input.length : undefined,
        });
        cleanup();
      },
    );
  }

  #openAIRequestPreparation(options: ChainedRunOptions): ApplicationRequestPreparation | undefined {
    const provider = this.#agentConfig.getProvider();
    const snapshot = options.providerHistorySnapshot;
    if (
      provider !== 'openai' ||
      this.#agentConfig.isTransientClient ||
      !snapshot ||
      options.providerContinuityLineage === undefined
    ) {
      return undefined;
    }
    const binding = {
      snapshotIdentity: snapshot.identity,
      snapshotRevision: snapshot.revision,
      lineage: options.providerContinuityLineage,
    };
    let canonicalSnapshot: ReturnType<typeof normalizeApplicationInput>;
    try {
      canonicalSnapshot = normalizeApplicationInput(snapshot.history);
    } catch {
      // A malformed/restored snapshot must never establish provider-private
      // ownership. The application request itself still proceeds normally.
      return undefined;
    }
    return {
      prepare: (request) => {
        // Bind only the actual request selected by the application run loop,
        // not a guessed continuation-state prefix. The OpenAI transport
        // consumes the application-owned input directly.
        if (!isDeepStrictEqual(canonicalSnapshot, request.input)) return;
        prepareOpenAIRequestPrefixBinding(binding, request.input);
      },
      // Keep the handoff alive through the complete async model invocation.
      run: (operation) => runWithOpenAIRequestPrefixBindingScope(operation),
    };
  }

  async startStream(userInput: ProviderInput, options: ChainedRunOptions = {}): Promise<AgentStream> {
    this.#subagentBridge?.resetAbortController();
    // Stop whatever is streaming without judging the turn's fate: a retry
    // restarts the stream of the turn already in progress, and the turn-ending
    // abort() here discarded the injections waiting for the very segment about
    // to start. Same distinction as continueRunStream. A genuinely new turn is
    // settled by the run loop instead — see its startStream and openTurn.
    // Allocate the controller before the first await: Codex model discovery can
    // suspend startStream, and this must still cancel that not-yet-started run.
    this.#abortActiveWork(() => this.#applicationRunLoop.abortSegment());
    const startController = new AbortController();
    this.#activeStartController = startController;
    try {
      await this.#prepareStart(userInput, options, startController.signal);
      if (startController.signal.aborted) {
        throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
      }
      const provider = this.#agentConfig.getProvider();
      const supportsChaining = getProvider(provider)?.capabilities?.supportsConversationChaining === true;
      const agent = this.#agentConfig.getApplicationAgent(options.sessionId);
      const requestPreparation = this.#openAIRequestPreparation(options);
      const run = () => {
        return this.#applicationRunLoop.startStream(agent, userInput, {
          ...(requestPreparation ? { requestPreparation } : {}),
          ...(supportsChaining && options.previousResponseId ? { previousResponseId: options.previousResponseId } : {}),
          providerId: provider,
          supportsConversationChaining: supportsChaining,
          sessionId: options.sessionId,
          turnId: options.hookTurnId,
          hookScope: this.#hookScope,
          ...(options.sessionId ? { context: { sessionId: options.sessionId } } : {}),
          maxTurns: this.#maxTurns,
        });
      };
      const stream = run();
      this.#activeStartController = null;
      this.#observeCompletion(stream, userInput, provider, this.#agentConfig.getModel());
      return stream;
    } catch (error) {
      if (this.#activeStartController === startController) this.#activeStartController = null;
      throw error;
    }
  }

  async continueRunStream(state: ContinuationHandle, options: ChainedRunOptions = {}): Promise<AgentStream> {
    this.#subagentBridge?.resetAbortController();
    // The turn is resuming, not ending: keep anything waiting for this segment.
    this.#abortActiveWork(() => this.#applicationRunLoop.abortSegment());
    const provider = this.#agentConfig.getProvider();
    const supportsChaining = getProvider(provider)?.capabilities?.supportsConversationChaining === true;
    const requestPreparation = this.#openAIRequestPreparation(options);
    const stream = this.#applicationRunLoop.continueRunStream(state, {
      ...(requestPreparation ? { requestPreparation } : {}),
      ...(supportsChaining && options.previousResponseId ? { previousResponseId: options.previousResponseId } : {}),
      providerId: provider,
      supportsConversationChaining: supportsChaining,
      sessionId: options.sessionId,
      turnId: options.hookTurnId,
      hookScope: this.#hookScope,
      maxTurns: this.#maxTurns,
      ...(options.stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
    });
    this.#observeCompletion(stream, state, provider, this.#agentConfig.getModel());
    return stream;
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

function backgroundShellEventToConversationEvent(
  event: BackgroundShellEvent<BackgroundShellExecutionResult>,
): ConversationEvent {
  if (event.type === 'background_shell_started') {
    return event;
  }
  return {
    type: 'background_shell_completed',
    jobId: event.jobId,
    command: event.command,
    status: event.status,
    output: event.output?.output ?? event.error ?? '',
    ...(event.error ? { error: event.error } : {}),
  };
}
