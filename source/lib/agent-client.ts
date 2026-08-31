import {
  normalizeApplicationInput,
  type ApplicationAgent,
  type ApplicationRequestPreparation,
  type SteerOutcome,
} from '../services/agent-runtime/application-run-loop.js';
import { readRunBudgetPolicy, type RunBudgetPolicy } from '../services/agent-runtime/run-budget.js';
import type { ContinuationHandle } from '../contracts/continuation-handle.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { JsonSchemaDefinition } from '../contracts/model-types.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ExecutionContext } from '../services/execution-context.js';
import { AskUserAnswerStore } from './ask-user-answer-store.js';
import { AgentConfiguration } from './agent-configuration.js';
import { SkillsService } from '../services/skills/skills-service.js';

import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import type { ContextCompactionSessionState, StreamedModelTurn } from '../contracts/streamed-model-turn.js';
import { SubagentBridge } from './subagent-bridge.js';
import { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import { AgentChatService } from './agent-chat-service.js';
import type { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { PostExecutePauseCapability, ToolExecutionLifecyclePort } from '../tools/types.js';
import type { Term2HookScope } from '../services/hooks/hook-contracts.js';
import type { SessionAccessState } from '../services/session/session-access-state.js';
import { ShellChildRegistry } from '../utils/shell/shell-child-registry.js';
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
  type ForegroundShellLeaseDetails,
  type ForegroundShellTransferResult,
  type BackgroundShellJob,
  type BackgroundShellRegistry,
} from '../services/shell/background-shell-registry.js';
import type { BackgroundShellExecutionResult } from '../tools/system/shell.js';
import type { BackgroundShellOutputBundle } from '../services/shell/background-shell-watches.js';
import type {
  SubagentCancelAcknowledgement,
  SubagentRunHandle,
  SubagentRunStatus,
} from '../services/subagents/types.js';
import type { BackgroundSubagentApprovalPauseSink } from '../services/subagents/foreground-subagent-lease.js';
import type { ForegroundSubagentCandidate } from '../services/subagents/nested-runner.js';
import type { NestedToolCompatibilityState } from '../services/session/nested-tool-compatibility-state.js';
import {
  ContextCompactionHardFitError,
  LocalContextCompactor,
} from '../services/agent-runtime/context-compaction/local-context-compactor.js';
import { CONTEXT_COMPACTION_INSTRUCTIONS } from '../prompts/context-compaction.js';
import { getCatalogModel } from '../providers/model-catalog/catalog.js';
import { supportsContextCompactionModel } from '../providers/openai-responses-model.js';
import {
  estimateContext,
  resolveCompactionThreshold,
  shouldDeferAutomaticCompaction,
} from '../services/agent-runtime/context-compaction/index.js';
import { projectConversationMessage } from '../services/conversation/conversation-message-projection.js';
import { isLocalContextSummary } from '../contracts/provider-input.js';
import { ContextMilestoneReminder } from '../services/agent-runtime/context-compaction/context-milestone-reminder.js';
import type {
  SessionRolloverConsumption,
  SessionRolloverRequest,
  SessionRolloverRequestOutcome,
} from '../contracts/session-rollover.js';

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
  #shellChildRegistry = new ShellChildRegistry();
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
  #requestCapture?: ProviderRequestCapture;
  #subagentBridge: SubagentBridge | null = null;
  #askUserAnswerStore: AskUserAnswerStore;
  #isDisposed = false;
  #toolLifecycle?: ToolExecutionLifecyclePort;
  #onToolDispatch?: (callId: string) => void;
  #hookScope: Term2HookScope = 'root';
  #backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;
  #backgroundShellOutput?: BackgroundShellOutputBundle;
  #wrapUpOnCriticalRunBudget = false;
  // Application streamed models own session-scoped transport state (notably
  // ResponsesWS), so recreate them only when the provider configuration changes.
  #streamedModelCache = new Map<string, StreamedModelTurn | Promise<StreamedModelTurn>>();
  #contextMilestoneReminder = new ContextMilestoneReminder();
  #sessionRolloverRequest: SessionRolloverRequest | null = null;

  #clearStreamedModelCache(): void {
    for (const cached of this.#streamedModelCache.values()) {
      void Promise.resolve(cached)
        .then((model) => (model as StreamedModelTurn & { close?: () => void }).close?.())
        .catch(() => undefined);
    }
    this.#streamedModelCache.clear();
  }

  #resolveStreamedModel(selectedModel: string): StreamedModelTurn | Promise<StreamedModelTurn> {
    const providerId = this.#agentConfig.getProvider();
    const provider = getProvider(providerId);
    if (!provider?.createStreamedModel) {
      throw new Error(`Provider '${providerId}' does not expose an application streamed model.`);
    }
    const cacheKey = `${providerId}\u0000${selectedModel}`;
    let model = this.#streamedModelCache.get(cacheKey);
    if (!model) {
      model = provider.createStreamedModel(selectedModel, {
        settingsService: this.#settings,
        loggingService: this.#logger,
        sessionContextService: this.#sessionContextService,
        onRetry: () => this.#retryCallback?.(),
        retryAttempts: this.#retryAttempts,
        requestCapture: this.#requestCapture,
        contextCompactionSessionState: this.#contextCompactionSessionState,
      });
      this.#streamedModelCache.set(cacheKey, model);
      if (model instanceof Promise) {
        void model.catch(() => {
          if (this.#streamedModelCache.get(cacheKey) === model) this.#streamedModelCache.delete(cacheKey);
        });
      }
    }
    return model;
  }

  async #compactCodexHistory(input: {
    history: readonly ProviderInputItem[];
    model: string;
    automaticCompactionsThisRun: number;
    signal?: AbortSignal;
    onStarted: (provider: string) => void;
    manual: boolean;
  }): Promise<
    | { kind: 'unchanged' }
    | { kind: 'failed'; provider: string }
    | { kind: 'compacted'; history: ProviderInputItem[]; modelInput: ProviderInputItem[] }
  > {
    const catalog = getCatalogModel('codex', input.model);
    const threshold = resolveCompactionThreshold({
      contextWindow: catalog?.contextWindow,
      compactThreshold: this.#settings.get('agent.contextCompaction.compactThreshold') ?? 0.8,
      compactThresholdTokens: this.#settings.get('agent.contextCompaction.compactThresholdTokens') ?? null,
    });
    const estimate = estimateContext({
      history: input.history,
      contextWindow: catalog?.contextWindow,
      maxOutputTokens: catalog?.maxTokens,
    });
    if (!input.manual) {
      if (!threshold.available || estimate.renderedInputTokens < threshold.effectiveThreshold) {
        return { kind: 'unchanged' };
      }
      const deferred = shouldDeferAutomaticCompaction({
        automaticCompactionsThisRun: input.automaticCompactionsThisRun,
        renderedInputTokens: estimate.renderedInputTokens,
        hasCompleteNewUserTurn: true,
      });
      if (deferred) return { kind: 'unchanged' };
    }
    const streamed = await this.#resolveStreamedModel(input.model);
    if (!streamed.compactHistory) {
      this.#logger.warn('Codex compact endpoint is unavailable; continuing with uncompacted history', {
        model: input.model,
      });
      return { kind: 'unchanged' };
    }
    input.onStarted('codex');
    try {
      const compacted = await streamed.compactHistory({
        input: normalizeApplicationInput(input.history),
        signal: input.signal,
      });
      const history = compacted.history as ProviderInputItem[];
      if (history.length === 0) {
        throw new Error('Codex compact endpoint returned an empty history');
      }
      return { kind: 'compacted', history, modelInput: history };
    } catch (error) {
      this.#logger.warn('Codex compact endpoint failed; continuing with uncompacted history', {
        model: input.model,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'failed', provider: 'codex' };
    }
  }

  #boundaryCompaction() {
    const enabled = this.#settings.get('agent.contextCompaction.enabled');
    if (!enabled) return undefined;
    return {
      compact: async ({
        history,
        automaticCompactionsThisRun,
        signal,
        onStarted,
      }: {
        history: readonly ProviderInputItem[];
        automaticCompactionsThisRun: number;
        signal?: AbortSignal;
        onStarted: (provider: string) => void;
      }) => {
        const mode = this.#settings.get('agent.contextCompaction.mode') ?? 'native';
        const provider = this.#agentConfig.getProvider();
        const model = this.#agentConfig.getModel();
        const reasoningEffort = this.#settings.get('agent.reasoningEffort');
        const catalog = getCatalogModel(provider, model);
        const openaiInlineNative =
          getProvider(provider)?.capabilities?.supportsContextCompaction === true &&
          supportsContextCompactionModel(model) &&
          !this.#contextCompactionSessionState.disabled;
        if (provider === 'codex' && mode !== 'local') {
          return this.#compactCodexHistory({
            history,
            model,
            automaticCompactionsThisRun,
            signal,
            onStarted,
            manual: false,
          });
        }
        if (mode === 'native' || (mode === 'auto' && openaiInlineNative)) return { kind: 'unchanged' as const };

        const configuredMaxOutput = this.#settings.get('agent.maxOutputTokens');
        let started = false;
        const compactor = new LocalContextCompactor({
          generate: async ({ renderedInput, maxOutputTokens }) => {
            if (!started) {
              started = true;
              onStarted(provider);
            }
            const result = await this.#chatService.chatDetailed(renderedInput, {
              provider,
              model,
              reasoningEffort,
              instructions: CONTEXT_COMPACTION_INSTRUCTIONS,
              maxTokens: maxOutputTokens,
            });
            return {
              text: result.text,
              usage: result.usage
                ? { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens }
                : undefined,
              costRecords: result.costRecords,
            };
          },
        });
        const checkpoint = history.find(isLocalContextSummary)?.contextSummary;
        let outcome;
        try {
          outcome = await compactor.compactAtBoundary({
            history,
            provider,
            model,
            sourceRevision: 0,
            contextWindow: catalog?.contextWindow,
            maxOutputTokens:
              configuredMaxOutput === undefined
                ? catalog?.maxTokens
                : Math.min(configuredMaxOutput, catalog?.maxTokens ?? configuredMaxOutput),
            compactThreshold: this.#settings.get('agent.contextCompaction.compactThreshold') ?? 0.8,
            compactThresholdTokens: this.#settings.get('agent.contextCompaction.compactThresholdTokens') ?? null,
            manual: false,
            automaticCompactionsThisRun,
            hasCompleteNewUserTurn: true,
            checkpoint: checkpoint ? { rearmAtEstimatedTokens: checkpoint.rearmAtEstimatedTokens } : undefined,
            signal,
          });
        } catch (error) {
          this.#logger.warn('Automatic local context compaction failed; continuing with uncompacted history', {
            provider,
            model,
            error: error instanceof Error ? error.message : String(error),
          });
          return started ? { kind: 'failed' as const, provider } : { kind: 'unchanged' as const };
        }
        if (
          outcome.kind === 'blocked' &&
          (outcome.reason === 'single_turn_too_large' || outcome.reason === 'result_still_too_large')
        ) {
          throw new ContextCompactionHardFitError(outcome.reason);
        }
        if (outcome.kind !== 'compacted') {
          // A blocked outcome leaves context growing, so it must be visible in
          // the log even though it is not a failure the user can act on.
          if (outcome.kind === 'blocked') {
            this.#logger.warn('Local context compaction blocked; continuing with uncompacted history', {
              provider,
              model,
              reason: outcome.reason,
              renderedInputTokens: outcome.estimate.renderedInputTokens,
            });
          }
          return { kind: 'unchanged' as const };
        }
        if (outcome.droppedOpaqueItems > 0) {
          this.#logger.debug('Local context compaction dropped provider-opaque items with their cold turns', {
            provider,
            model,
            droppedOpaqueItems: outcome.droppedOpaqueItems,
          });
        }
        const genuineUsers = history.filter((item) => {
          const message = projectConversationMessage(item);
          return message?.role === 'user' && !message.isSynthetic;
        });
        const hotUsers = outcome.hotTail.filter((item) => {
          const message = projectConversationMessage(item);
          return message?.role === 'user' && !message.isSynthetic;
        }).length;
        const preservedUsers = hotUsers === 0 ? genuineUsers : genuineUsers.slice(0, -hotUsers);
        return {
          kind: 'compacted' as const,
          history: [...preservedUsers, outcome.checkpoint, ...outcome.hotTail],
          modelInput: [outcome.checkpoint, ...outcome.hotTail],
          costRecords: outcome.costRecords,
        };
      },
    };
  }

  #observeContextMilestones(
    history: readonly ProviderInputItem[],
    onReminder: (text: string) => void,
  ): { deferCompaction: true } | undefined {
    const provider = this.#agentConfig.getProvider();
    const model = this.#agentConfig.getModel();
    const catalog = getCatalogModel(provider, model);
    const agent = this.#agentConfig.getApplicationAgent();
    const threshold = resolveCompactionThreshold({
      contextWindow: catalog?.contextWindow,
      compactThreshold: this.#settings.get('agent.contextCompaction.compactThreshold') ?? 0.8,
      compactThresholdTokens: this.#settings.get('agent.contextCompaction.compactThresholdTokens') ?? null,
    });
    const estimate = estimateContext({
      history,
      instructions: agent.instructions,
      tools: agent.tools,
      contextWindow: catalog?.contextWindow,
      maxOutputTokens: catalog?.maxTokens,
    });
    const canSafelyDeferCompaction =
      catalog?.contextWindow !== undefined && estimate.hardFitTokens <= catalog.contextWindow;
    const config = {
      enabled: this.#settings.get('agent.sessionRollover.enabled') ?? true,
      milestones: this.#settings.get('agent.sessionRollover.milestones') ?? [],
      autoBrief: this.#settings.get('agent.sessionRollover.autoBrief') ?? true,
    };
    const reminders = this.#contextMilestoneReminder.observe(
      estimate,
      config,
      canSafelyDeferCompaction && this.#settings.get('agent.contextCompaction.enabled') && threshold.available
        ? threshold.effectiveThreshold
        : undefined,
    );
    for (const reminder of reminders) {
      onReminder(reminder);
    }
    return canSafelyDeferCompaction && (reminders.length > 0 || this.#sessionRolloverRequest !== null)
      ? { deferCompaction: true }
      : undefined;
  }

  /**
   * Forward real-time subagent activity events to the active conversation
   * turn. The session sets this for the duration of a send and clears it
   * afterwards so events reach the UI's onEvent callback.
   */
  setSubagentEventSink(
    sink: ((event: ConversationEvent) => void | PromiseLike<void>) | null,
  ): void | PromiseLike<void> {
    return this.#subagentBridge?.setEventSink(sink);
  }

  /**
   * Forward subagent activity events to a conversation-scoped consumer that
   * stays attached across turns. Used to observe background (async) subagent
   * runs that settle while no turn is in flight.
   */
  setBackgroundSubagentEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    this.#subagentBridge?.setBackgroundEventSink(sink);
  }

  /** Session-owned queue/control delivery for pauses from adopted child runs. */
  setBackgroundSubagentApprovalPauseSink(sink: BackgroundSubagentApprovalPauseSink | null): void {
    this.#subagentBridge?.setBackgroundApprovalPauseSink(sink);
  }

  requestSessionRollover(request: SessionRolloverRequest): SessionRolloverRequestOutcome {
    const active = this.#liveBackgroundWork();
    if (active.subagent > 0 || active.shell > 0) {
      return {
        ok: false,
        status: 'rollover_blocked',
        error: 'Session rollover is blocked while background work is live.',
        active,
      };
    }
    this.#sessionRolloverRequest ??= request;
    return { ok: true, status: 'rollover_requested' };
  }

  consumeSessionRolloverRequest(): SessionRolloverConsumption {
    const request = this.#sessionRolloverRequest;
    this.#sessionRolloverRequest = null;
    if (!request) return { status: 'none' };

    const active = this.#liveBackgroundWork();
    if (active.subagent > 0 || active.shell > 0) {
      return {
        status: 'blocked',
        blocker: 'background_work',
        error: 'Session rollover was not performed because background work became live before turn settlement.',
        active,
      };
    }
    return { status: 'ready', request };
  }

  #liveBackgroundWork(): { shell: number; subagent: number } {
    const subagent = this.listBackgroundSubagentStatuses().filter(
      ({ status }) =>
        status === 'running' ||
        status === 'awaiting_approval' ||
        status === 'waiting_for_answer' ||
        status === 'cancelling',
    ).length;
    const shell = this.listBackgroundShellJobs().filter(
      ({ status }) => status === 'running' || status === 'cancelling',
    ).length;
    return { shell, subagent };
  }

  /** Exact nested-tool state shared with the subagent runtime's tool factory. */
  getNestedToolCompatibilityState(): NestedToolCompatibilityState | undefined {
    return this.#subagentBridge?.getNestedToolCompatibilityState();
  }

  /** Route root shell-job lifecycle through the durable conversation sink. */
  setBackgroundShellEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    this.#backgroundShellRegistry?.setEventSink(
      sink ? (event) => sink(backgroundShellEventToConversationEvent(event)) : undefined,
    );
    // Watch firings ride the same conversation lane: a firing is converted to
    // the background_shell_output conversation event and pushed to the sink,
    // so it is enqueued in exactly-once order with job completions.
    this.#backgroundShellOutput?.watches.setOnFiring(
      sink
        ? (firing) => {
            sink(
              backgroundShellEventToConversationEvent({
                type: 'background_shell_output',
                jobId: firing.jobId,
                command: firing.command ?? '',
                watchId: firing.watchId,
                seq: firing.seq,
                matchedLines: firing.matchedLines,
                coalescedCount: firing.coalescedCount,
                seqRange: firing.seqRange,
                ...(firing.droppedBytes !== undefined ? { droppedBytes: firing.droppedBytes } : {}),
              }),
            );
          }
        : undefined,
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
    backgroundShellOutput,
    allowBackgroundShell = true, // Retained for session-factory compatibility; direct execution no longer
    allowAskUser = true,
    wrapUpOnCriticalRunBudget = false,
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
      /** Supplied only by the interactive CLI root composition. */
      sessionBrowser?: import('../services/conversation/session-browser.js').SessionBrowser;
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
    /** Root-session-owned output store + watch layer. Nested clients deliberately omit it. */
    backgroundShellOutput?: BackgroundShellOutputBundle;
    /** False for one-shot/non-interactive callers until their lifecycle is supported. */
    allowBackgroundShell?: boolean;
    /** False for non-interactive / headless sessions where user prompts cannot be answered. */
    allowAskUser?: boolean;
    /** Transient subagents terminate through one tool-free summary call at critical. */
    wrapUpOnCriticalRunBudget?: boolean;
    continuationProjectionMode?: ContinuationProjectionMode;
  }) {
    this.#logger = deps.logger;
    this.#toolInterceptorRegistry = new ToolInterceptorRegistry({ logger: this.#logger });
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#toolLifecycle = toolLifecycle;
    this.#hookScope = hookScope ?? 'root';
    this.#backgroundShellRegistry = allowBackgroundShell ? backgroundShellRegistry : undefined;
    this.#backgroundShellOutput = allowBackgroundShell ? backgroundShellOutput : undefined;
    this.#wrapUpOnCriticalRunBudget = wrapUpOnCriticalRunBudget;
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
        backgroundShellOutput: this.#backgroundShellOutput,
        shellChildRegistry: this.#shellChildRegistry,
        allowBackgroundShell,
        allowAskUser,
        sessionBrowser: deps.sessionBrowser,
        onConfigChanged: (_changedKey?: string) => {
          // Models capture provider/settings at creation time.
          this.#clearStreamedModelCache();
          this.#chatService?.clearModelCache();
          // Always clear subagent cache and reset mentor state
          this.#subagentBridge?.clearCache();
          this.#resetMentorState();
        },
        requestSessionRollover: deps.sessionBrowser
          ? (request: SessionRolloverRequest) => this.requestSessionRollover(request)
          : undefined,
      },
    );
    this.#maxTurns = maxTurns ?? (agentOverride ? 1 : 20);
    this.#retryAttempts = retryAttempts ?? 2;
    this.#requestCapture = deps.requestCapture;
    this.#applicationRunLoop = new ApplicationRunLoop({
      toolLifecycle: this.#toolLifecycle,
      getOnToolDispatch: () => this.#onToolDispatch,
      contextCompactionSessionState: this.#contextCompactionSessionState,
      resolveMaxParallelToolCalls: () => deps.settings.get('agent.maxParallelToolCalls'),
      logDiagnostic: (message, meta) => deps.logger.info(message, meta),
      resolveModel: (selectedModel) => this.#resolveStreamedModel(selectedModel),
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
            wrapUpOnCriticalRunBudget: true,
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

  /**
   * Wire session tool-ledger dispatch marking. Called after composition creates
   * the tracker so mid-tool stream recovery can settle as `unknown`.
   */
  setOnToolDispatch(handler: ((callId: string) => void) | undefined): void {
    this.#onToolDispatch = handler;
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
   * The settings envelope, with the turn backstop honoring `agent.maxTurns`.
   *
   * A run budget suppresses the loop's `MaxTurnsExceededError`, so without this
   * a configured `agent.maxTurns: 10` would silently stop meaning anything and
   * the run would go all the way to `turnBackstop`. Taking the tighter of the
   * two keeps the live setting effective while leaving the backstop's role as
   * the infinite-loop tripwire intact.
   */
  #runBudgetPolicy(): RunBudgetPolicy {
    const policy = readRunBudgetPolicy(this.#settings);
    return { ...policy, turnBackstop: Math.min(policy.turnBackstop, this.#maxTurns) };
  }

  /** Grant one finite extension to the active run-budget envelope. */
  grantRunBudgetExtension(): { granted: boolean; extensionsGranted: number } {
    return this.#applicationRunLoop.grantRunBudgetExtension();
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

  getBackgroundSubagentStatus(runId: string): SubagentRunStatus {
    return (
      this.#subagentBridge?.getBackgroundSubagentStatus(runId) ?? {
        runId,
        role: '',
        status: 'not_found',
        task: '',
        taskPreview: '',
        startedAt: 0,
        elapsedMs: 0,
        toolCounts: {},
      }
    );
  }

  listBackgroundSubagentStatuses(): SubagentRunStatus[] {
    return this.#subagentBridge?.listBackgroundSubagentStatuses() ?? [];
  }

  requestBackgroundSubagentStop(runId: string): SubagentCancelAcknowledgement {
    return (
      this.#subagentBridge?.requestBackgroundSubagentStop(runId) ?? { ok: false, code: 'not_active', target: runId }
    );
  }

  /** Foreground runs that can be moved without constructing a second execution. */
  listForegroundSubagentCandidates(): ForegroundSubagentCandidate[] {
    return this.#subagentBridge?.listForegroundSubagentCandidates() ?? [];
  }

  /** Atomically hands one live nested child to the background registry. */
  moveForegroundSubagent(runId: string): SubagentRunHandle | undefined {
    return this.#subagentBridge?.moveForegroundSubagent(runId);
  }

  getBackgroundShellJob(jobId: string): BackgroundShellJob<BackgroundShellExecutionResult> | undefined {
    return this.#backgroundShellRegistry?.get(jobId);
  }

  listBackgroundShellJobs(): BackgroundShellJob<BackgroundShellExecutionResult>[] {
    return this.#backgroundShellRegistry?.list() ?? [];
  }

  getBackgroundShellOutputTail(jobId: string, maxBytes?: number): string | undefined {
    return this.#backgroundShellOutput?.store.readTail(jobId, maxBytes)?.text;
  }

  requestBackgroundShellStop(jobId: string): boolean {
    return this.#backgroundShellRegistry?.cancel(jobId) ?? false;
  }

  /** The current root shell call that can still be detached from its turn. */
  getForegroundShellTransferCandidate(): ForegroundShellLeaseDetails | undefined {
    return this.#backgroundShellRegistry?.listForeground()[0];
  }

  /** Atomically detaches a root shell call from its foreground turn. */
  moveForegroundShellToBackground(callId: string): ForegroundShellTransferResult | undefined {
    return this.#backgroundShellRegistry?.adoptForeground(callId);
  }

  cancelBackgroundShellJobs(): void {
    for (const job of this.#backgroundShellRegistry?.list() ?? []) {
      this.#backgroundShellRegistry?.cancel(job.id);
    }
  }

  disposeBackgroundShellJobs(): Promise<void> {
    return this.#backgroundShellRegistry?.dispose() ?? Promise.resolve();
  }

  disposeShellChildren(): void {
    this.#shellChildRegistry.killAll();
  }

  /** Await adopted child-run settlement before the session detaches its sinks. */
  disposeBackgroundSubagents(): Promise<void> {
    return this.#subagentBridge?.disposeBackgroundSubagents() ?? Promise.resolve();
  }

  /** End all session-bound activity and release resources held by this client. */
  dispose(): void {
    if (this.#isDisposed) return;
    this.#isDisposed = true;

    this.abort();
    this.disposeShellChildren();
    void this.disposeBackgroundShellJobs();
    this.#clearStreamedModelCache();
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
          traceId: correlationId ?? undefined,
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
      const supportsChaining = this.supportsConversationChaining();
      const agent = this.#agentConfig.getApplicationAgent(options.sessionId);
      const requestPreparation = this.#openAIRequestPreparation(options);
      const boundaryCompaction = this.#boundaryCompaction();
      const runBudget = this.#runBudgetPolicy();
      const run = () => {
        return this.#applicationRunLoop.startStream(agent, userInput, {
          ...(boundaryCompaction ? { boundaryCompaction } : {}),
          ...(requestPreparation ? { requestPreparation } : {}),
          ...(supportsChaining && options.previousResponseId && !options.disableChainingForAttempt
            ? { previousResponseId: options.previousResponseId }
            : {}),
          ...(options.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
          providerId: provider,
          supportsConversationChaining: supportsChaining,
          sessionId: options.sessionId,
          turnId: options.hookTurnId,
          hookScope: this.#hookScope,
          ...(options.sessionId ? { context: { sessionId: options.sessionId } } : {}),
          maxTurns: this.#maxTurns,
          runBudget,
          ...(this.#wrapUpOnCriticalRunBudget ? { wrapUpOnCriticalRunBudget: true } : {}),
          ...(options.onRunBudgetEvent ? { onRunBudgetEvent: options.onRunBudgetEvent } : {}),
          onRequestBoundary: (history, onReminder) => this.#observeContextMilestones(history, onReminder),
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
    const supportsChaining = this.supportsConversationChaining();
    const requestPreparation = this.#openAIRequestPreparation(options);
    const boundaryCompaction = this.#boundaryCompaction();
    const runBudget = this.#runBudgetPolicy();
    const stream = this.#applicationRunLoop.continueRunStream(state, {
      ...(boundaryCompaction ? { boundaryCompaction } : {}),
      ...(requestPreparation ? { requestPreparation } : {}),
      ...(supportsChaining && options.previousResponseId && !options.disableChainingForAttempt
        ? { previousResponseId: options.previousResponseId }
        : {}),
      ...(options.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
      providerId: provider,
      supportsConversationChaining: supportsChaining,
      sessionId: options.sessionId,
      turnId: options.hookTurnId,
      hookScope: this.#hookScope,
      maxTurns: this.#maxTurns,
      runBudget,
      ...(this.#wrapUpOnCriticalRunBudget ? { wrapUpOnCriticalRunBudget: true } : {}),
      ...(options.onRunBudgetEvent ? { onRunBudgetEvent: options.onRunBudgetEvent } : {}),
      onRequestBoundary: (history, onReminder) => this.#observeContextMilestones(history, onReminder),
      ...(options.stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
    });
    this.#observeCompletion(stream, state, provider, this.#agentConfig.getModel());
    return stream;
  }

  async compactCodexSessionHistory(
    history: readonly ProviderInputItem[],
    signal?: AbortSignal,
  ): Promise<
    { kind: 'unchanged' } | { kind: 'failed'; provider: string } | { kind: 'compacted'; history: ProviderInputItem[] }
  > {
    const outcome = await this.#compactCodexHistory({
      history,
      model: this.#agentConfig.getModel(),
      automaticCompactionsThisRun: 0,
      signal,
      onStarted: () => undefined,
      manual: true,
    });
    if (outcome.kind === 'compacted') return { kind: 'compacted', history: outcome.history };
    return outcome;
  }

  async chat(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ReasoningEffortSetting | null;
      instructions?: string;
      maxTokens?: number;
    } = {},
  ): Promise<string> {
    return this.#chatService.chat(message, options);
  }

  async chatDetailed(
    message: string,
    options: {
      model?: string;
      provider?: string;
      reasoningEffort?: ReasoningEffortSetting | null;
      instructions?: string;
      maxTokens?: number;
    } = {},
  ) {
    return this.#chatService.chatDetailed(message, options);
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

export function backgroundShellEventToConversationEvent(
  event: BackgroundShellEvent<BackgroundShellExecutionResult>,
): ConversationEvent {
  if (event.type === 'background_shell_started') {
    return event;
  }
  if (event.type === 'background_shell_output') {
    return {
      type: 'background_shell_output',
      jobId: event.jobId,
      command: event.command,
      watchId: event.watchId,
      seq: event.seq,
      matchedLines: event.matchedLines,
      ...(event.coalescedCount !== undefined ? { coalescedCount: event.coalescedCount } : {}),
      ...(event.seqRange !== undefined ? { seqRange: event.seqRange } : {}),
      ...(event.droppedBytes !== undefined ? { droppedBytes: event.droppedBytes } : {}),
    };
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
