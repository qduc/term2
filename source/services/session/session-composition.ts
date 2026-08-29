import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { getCatalogModel } from '../../providers/model-catalog/catalog.js';
import { CONTEXT_COMPACTION_INSTRUCTIONS } from '../../prompts/context-compaction.js';
import { projectConversationMessage } from '../conversation/conversation-message-projection.js';
import {
  LocalContextCompactor,
  type LocalCompactionOutcome,
} from '../agent-runtime/context-compaction/local-context-compactor.js';
import type { SteerOutcome } from '../agent-runtime/application-run-loop.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { ApprovalState, type PendingApprovalContext } from '../approval/approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { getMethod, getToolInfoFromInterruption } from '../interruption-info.js';
import {
  ShellAutoApprovalResolver,
  DelegatingShellAutoApprovalResolver,
} from '../approval/shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import type { AssistantTurnState, LogEvent } from '../logging/conversation-log-events.js';
import type {
  AskUserAnswerSink,
  ConversationAgentClient,
  SubagentEventSinkHost,
} from '../conversation-agent-client.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { ProviderContinuity } from '../provider-continuity.js';
import type { OpenAIRootFreshTurnSelectorParityObserver } from '../openai-root-selector-parity-observer.js';
import type { OpenAIRootCheckpointLifecycleObserver } from '../openai-root-checkpoint-lifecycle-observer.js';
import { TurnCoordinator, type TurnStartOptions } from './turn-coordinator.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { SessionManager } from './session-manager.js';
import { SessionRuntimeController } from './session-runtime-controller.js';
import { ContinuationPlanApplier } from './continuation-plan-applier.js';
import { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';
import { DefaultConversationRecoveryPolicy } from '../retry/recovery-policy.js';
import { DefaultRecoveryExecutor } from '../retry/recovery-executor.js';
import { GenerationGuard } from '../generation-guard.js';
import { DefaultRetryClassifier } from '../retry/retry-classifier.js';
import { RetryEventPresenter } from '../retry/retry-event-presenter.js';
import { TurnWorkflow } from './turn-workflow.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import { TurnAttemptFactory } from './turn-attempt-factory.js';
import { InitialInputPreparer } from './initial-input-preparer.js';
import { InitialTurnRecoveryHandler } from './initial-turn-recovery-handler.js';
import { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import { SessionContinuityReset } from './session-continuity-reset.js';
import {
  SubagentNotificationStore,
  type BackgroundSubagentNotificationPort,
  type BackgroundSubagentTaskPort,
} from '../subagents/subagent-notification-store.js';
import { BackgroundTaskControl, type BackgroundTaskControlPort } from './background-task-control.js';
import type { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import {
  PostExecutePendingRegistry,
  type PostExecuteDecisionRequest,
  type PostExecuteDecisionResult,
  type PostExecutePendingSnapshot,
} from './post-execute-pending-registry.js';
import type { PostExecutePauseCapability } from './post-execute-pause-capability.js';
import type { SessionAccessState } from './session-access-state.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import { HookEventFactory } from '../hooks/hook-event-factory.js';
import { PendingInteractionState } from './pending-interaction-state.js';
import { BackgroundSubagentApprovalController } from '../approval/background-subagent-approval-controller.js';
import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import { registerSessionRuntime } from '../workspace/active-workspace-root.js';

const asAskUserAnswerSink = (value: unknown): AskUserAnswerSink | null =>
  value && typeof (value as AskUserAnswerSink).setAskUserAnswer === 'function' ? (value as AskUserAnswerSink) : null;

const asSubagentEventSinkHost = (value: unknown): SubagentEventSinkHost | null =>
  value && typeof (value as SubagentEventSinkHost).setSubagentEventSink === 'function'
    ? (value as SubagentEventSinkHost)
    : null;

const asBackgroundShellEventSinkHost = (
  value: unknown,
): Pick<ConversationAgentClient, 'setBackgroundShellEventSink'> | null =>
  value && typeof (value as ConversationAgentClient).setBackgroundShellEventSink === 'function'
    ? (value as Pick<ConversationAgentClient, 'setBackgroundShellEventSink'>)
    : null;

// ── Public types ──────────────────────────────────────────────────

export type ConversationSessionRetryOptions = {
  /**
   * When false, retries are only allowed if an AgentStream exists so the turn
   * can resume from captured history instead of replaying from the beginning.
   */
  allowFreshStartRetries?: boolean;
};

/** @internal Full collaborator graph; used only by tests + the test helper. */
export type SessionRuntimeInternals = {
  sessionId: string;
  sessionStartedAt: string;
  logger: ILoggingService;
  conversationStore: ConversationStore;
  approvalState: ApprovalState;
  toolTracker: SessionToolTracker;
  toolCallMarkers: ToolCallMarkerStore;
  shellAutoApproval: ShellAutoApprovalResolver;
  approvalFlow: ApprovalFlowCoordinator;

  inputPlanner: SessionInputPlanner;
  state: SessionLifecycle;
  conversationLogger: ConversationLogger;
  streamProcessor: SessionStreamProcessor;
  appState: { statusMachine: TurnStatusMachine };
  turnCoordinator: TurnCoordinator;
  /** Facade for state/persistence/undo/snapshot operations. */
  stateFacade: SessionManager;
  /** Controller for runtime model/provider/retry settings. */
  runtimeController: SessionRuntimeController;
  /**
   * Idempotent disposal: aborts active SDK work, invalidates the active
   * generation, unsubscribes downgrade listeners, clears per-turn state.
   */
  dispose: () => void;
  shutdown: () => Promise<void>;
  generationGuard: GenerationGuard;
  providerContinuity: ProviderContinuity;
  breakChaining: () => void;
  compactContext: (options?: { signal?: AbortSignal }) => Promise<LocalCompactionOutcome | { kind: 'busy' | 'stale' }>;
  recoveryPolicy: DefaultConversationRecoveryPolicy;
  recoveryExecutor: DefaultRecoveryExecutor;
  retryClassifier: DefaultRetryClassifier;
  retryEventPresenter: RetryEventPresenter;
  turnAccumulator: TurnItemAccumulator;
  turnWorkflow: TurnWorkflow;
  freshStartRetriesAllowed: boolean;
  /** Stable assistant-output journal created during composition. */
  journal: AssistantTurnJournal;
  /** @internal Resolved ask-user-answer sink (derived from option or agent client). */
  resolvedAskUserAnswerSink: AskUserAnswerSink | null;
  /** @internal Resolved subagent event sink host (derived from option or agent client). */
  resolvedSubagentEventSinkHost: SubagentEventSinkHost | null;
  /** @internal Root shell lifecycle sink; nested runtimes omit this port. */
  resolvedBackgroundShellEventSinkHost: Pick<ConversationAgentClient, 'setBackgroundShellEventSink'> | null;
  /** Completions of background subagent runs still owed to the main agent. */
  backgroundSubagentNotifications: BackgroundSubagentNotificationChannel;
  /** Read-only lifecycle projection for background subagent UI. */
  backgroundSubagentTasks: BackgroundSubagentTaskChannel;
  /** FIFO approval control for adopted background subagents. */
  backgroundSubagentApprovals: BackgroundSubagentApprovalChannel;
  /** Per-item details and stop controls for session-owned background work. */
  backgroundTaskControl: BackgroundTaskControlPort;
  /** Session-owned fail-closed gates for post-execute policies. */
  postExecutePending: PostExecutePendingRegistry;
  /** Authoritative pending approval and ask_user protocol state. */
  pendingInteraction: PendingInteractionState;
};

// ── Options for the composition factory ──────────────────────────

/** @internal Options for the internal composition factory. */
export type CreateSessionRuntimeInternalsOptions = {
  sessionId: string;
  /** ISO timestamp; defaults to now. */
  sessionStartedAt?: string;
  agentClient: ConversationAgentClient;
  /** Handle-owned continuity shared with the root provider observer. */
  providerContinuity?: ProviderContinuity;
  /** Owned-root-only, observation-only selector parity seam. */
  openAIRootFreshTurnSelectorParityObserver?: OpenAIRootFreshTurnSelectorParityObserver;
  /** Owned-root OpenAI checkpoint diagnostic seam. */
  openAIRootCheckpointLifecycleObserver?: OpenAIRootCheckpointLifecycleObserver;
  toolOwnership: ToolOwnershipRegistry;
  postExecutePending?: PostExecutePendingRegistry;
  postExecutePauseCapability?: PostExecutePauseCapability;
  sessionAccess?: SessionAccessState;
  askUserAnswerSink?: AskUserAnswerSink | null;
  subagentEventSinkHost?: SubagentEventSinkHost | null;
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
  retryOptions?: ConversationSessionRetryOptions;
  turnAccumulator?: TurnItemAccumulator;
  /** Installed only on the root runtime; nested runtimes omit this port. */
  hookLifecycle?: HookLifecyclePort;
  hookEvents?: HookEventFactory;
  toolCallMarkers?: ToolCallMarkerStore;
};

export type CreateConversationSessionOptions = Omit<CreateSessionRuntimeInternalsOptions, 'turnAccumulator'>;
export type ConversationSessionBundle = Pick<
  SessionRuntimeInternals,
  | 'sessionId'
  | 'sessionStartedAt'
  | 'turnCoordinator'
  | 'stateFacade'
  | 'runtimeController'
  | 'conversationLogger'
  | 'approvalState'
  | 'shellAutoApproval'
  | 'toolTracker'
  | 'inputPlanner'
  | 'dispose'
  | 'journal'
>;

export type SessionApprovalQuery = {
  getPending(): PendingApprovalContext | null;
  getPendingInterruption(): unknown;
  /** Authoritative post-execute batch; notifications must re-read this snapshot. */
  getPostExecutePending(): PostExecutePendingSnapshot;
  /** Atomically settle selected post-execute entries from the displayed revision. */
  decidePostExecutePending(request: PostExecuteDecisionRequest): PostExecuteDecisionResult;
};

export type SessionLogs = {
  setLogSink(sink: ((event: LogEvent) => void) | null): void;
  dispatchEventToLog(event: ConversationEvent): void;
  log(event: LogEvent): void;
};

export type SessionSinks = {
  askUserAnswer: AskUserAnswerSink | null;
  subagentEvents: SubagentEventSinkHost | null;
};

/**
 * Pending completions of background (async) subagent runs, plus the wake-up
 * signal for whoever delivers them.
 *
 * The session owns the queue because the conversation-scoped background sink is
 * installed here and outlives every turn; the observer exists so the delivering
 * layer (which is the only one that knows whether the conversation is idle) does
 * not have to poll.
 */
export type BackgroundSubagentNotificationChannel = BackgroundSubagentNotificationPort & {
  /** Fires when a background run completion is newly queued. */
  setObserver(observer: (() => void) | null): void;
};

export type BackgroundSubagentTaskChannel = BackgroundSubagentTaskPort;

export type BackgroundSubagentApprovalChannel = Pick<
  BackgroundSubagentApprovalController,
  'getSnapshot' | 'subscribe' | 'resolve'
>;

// ── Session Runtime (public) ───────────────────────────────────────

/**
 * Clean public interface for a session runtime, exposing only the
 * capabilities needed by callers without leaking internal composition
 * details.
 */
export type SessionRuntime = {
  sessionId: string;
  sessionStartedAt: string;
  turns: {
    start: (input: string | UserTurn, options?: TurnStartOptions) => AsyncIterable<ConversationEvent>;
    continueAfterApproval: (options: {
      answer: string;
      rejectionReason?: string;
      stopAfterApprovalResolution?: boolean;
    }) => AsyncIterable<ConversationEvent>;
    continueAfterPostExecuteApproval: () => AsyncIterable<ConversationEvent>;
    abort: () => void;
    steer: (items: readonly ProviderInputItem[], options?: { id?: string }) => Promise<SteerOutcome>;
    /** Drop a still-waiting steer. False when it was already admitted. */
    retractSteer: (id: string) => boolean;
    /** Replace a waiting steer's items in place, keeping its position. */
    editSteer: (id: string, items: readonly ProviderInputItem[]) => boolean;
  };
  /** Facade for state/persistence/undo/snapshot operations. */
  state: SessionManager;
  /** Controller for runtime model/provider/retry settings. */
  settings: SessionRuntimeController;
  compactContext: (options?: { signal?: AbortSignal }) => Promise<LocalCompactionOutcome | { kind: 'busy' | 'stale' }>;
  logs: SessionLogs;
  approval: SessionApprovalQuery;
  /** Pending approval protocol projected by presentation layers. */
  pendingInteraction: PendingInteractionState;
  sinks: SessionSinks;
  /** Completions of background subagent runs still owed to the main agent. */
  backgroundSubagentNotifications: BackgroundSubagentNotificationChannel;
  /** Read-only lifecycle projection for background subagent UI. */
  backgroundSubagentTasks: BackgroundSubagentTaskChannel;
  /** FIFO approval control for adopted background subagents. */
  backgroundSubagentApprovals: BackgroundSubagentApprovalChannel;
  /** Per-item details and stop controls for session-owned background work. */
  backgroundTaskControl: BackgroundTaskControlPort;
  /**
   * Idempotent disposal: aborts active SDK work, invalidates the active
   * generation, unsubscribes downgrade listeners, clears per-turn state.
   */
  dispose: () => void;
  shutdown: () => Promise<void>;
};

// ── Composition factory ───────────────────────────────────────────

export function createSessionRuntimeInternals(options: CreateSessionRuntimeInternalsOptions): SessionRuntimeInternals {
  const {
    sessionId: id,
    sessionStartedAt,
    agentClient,
    providerContinuity: suppliedProviderContinuity,
    openAIRootFreshTurnSelectorParityObserver,
    openAIRootCheckpointLifecycleObserver,
    toolOwnership,
    postExecutePending: suppliedPostExecutePending,
    postExecutePauseCapability,
    sessionAccess,
    askUserAnswerSink,
    subagentEventSinkHost,
    deps,
    retryOptions,
    turnAccumulator,
    hookLifecycle,
    hookEvents: suppliedHookEvents,
    toolCallMarkers: suppliedToolCallMarkers,
  } = options;
  const { logger, settingsService, sessionContextService } = deps;
  const startedAt = sessionStartedAt ?? new Date().toISOString();
  const resolvedTurnAccumulator = turnAccumulator ?? new TurnItemAccumulator();
  const toolCallMarkers = suppliedToolCallMarkers ?? new ToolCallMarkerStore();
  const resolvedAskUserAnswerSink = askUserAnswerSink ?? asAskUserAnswerSink(agentClient);
  const resolvedSubagentEventSinkHost = subagentEventSinkHost ?? asSubagentEventSinkHost(agentClient);
  const resolvedBackgroundShellEventSinkHost = asBackgroundShellEventSinkHost(agentClient);

  // Background (async) subagent runs settle whenever they settle, including
  // while the conversation is idle and no per-turn sink is attached.
  let disposed = false;
  let syncPublicStatus: () => void = () => {};
  const notificationStore = new SubagentNotificationStore();
  let notificationObserver: (() => void) | null = null;
  let taskObserver: (() => void) | null = null;
  const backgroundSubagentNotifications: BackgroundSubagentNotificationChannel = {
    get pendingCount() {
      return notificationStore.pendingCount;
    },
    drain: () => notificationStore.drain(),
    retain: (notifications) => notificationStore.retain(notifications),
    enqueueUserControl: (notification) => notificationStore.enqueueUserControl(notification),
    setObserver: (observer) => {
      notificationObserver = observer;
    },
  };
  const backgroundSubagentTasks: BackgroundSubagentTaskChannel = {
    getSnapshot: () => notificationStore.getTaskSnapshot(),
    setObserver: (observer) => {
      taskObserver = observer;
    },
  };
  const backgroundTaskControl = new BackgroundTaskControl({
    client: agentClient,
    notifications: notificationStore,
    onNotification: () => {
      syncPublicStatus();
      try {
        notificationObserver?.();
      } catch (error) {
        logger.warn('Background task control notification observer threw', {
          eventType: 'subagent.control_notification_observer_failed',
          category: 'subagent',
          sessionId: id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onTaskChange: () => {
      syncPublicStatus();
      try {
        taskObserver?.();
      } catch (error) {
        logger.warn('Background task control task observer threw', {
          eventType: 'subagent.control_task_observer_failed',
          category: 'subagent',
          sessionId: id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  // This controller owns background-child approval policy and FIFO ordering.
  // It intentionally does not touch ApprovalState, which owns the root turn.
  const backgroundSubagentApprovals = new BackgroundSubagentApprovalController({
    logger,
    sessionId: id,
    toolOwnership,
    nestedCompatibility: getMethod<
      [],
      import('./nested-tool-compatibility-state.js').NestedToolCompatibilityState | undefined
    >(agentClient, 'getNestedToolCompatibilityState')?.call(agentClient),
  });

  const generationGuard = new GenerationGuard();
  // Factory-owned handles supply this same registry to the root tool policy.
  // Compatibility callers receive a fresh explicit token, never a wall-clock epoch.
  const postExecutePending =
    suppliedPostExecutePending ?? new PostExecutePendingRegistry({ sessionId: id, epoch: crypto.randomUUID() });

  const conversationStore = new ConversationStore();
  const approvalState = new ApprovalState();
  const pendingInteraction = new PendingInteractionState();
  const toolTracker = new SessionToolTracker(conversationStore);

  // Mark ledger dispatch when the run loop enters a tool body so stream recovery
  // can distinguish never-dispatched (aborted) from unobserved outcome (unknown).
  getMethod<[handler: ((callId: string) => void) | undefined], void>(agentClient, 'setOnToolDispatch')?.call(
    agentClient,
    (callId) => toolTracker.markDispatched(callId),
  );

  const shellAutoApproval = new DelegatingShellAutoApprovalResolver({
    conversationStore,
    agentClient,
    logger,
    settingsService,
    sessionContextService,
  });

  const appState = { statusMachine: new TurnStatusMachine() };
  const hookEvents = suppliedHookEvents ?? (hookLifecycle ? new HookEventFactory({ sessionId: id }) : undefined);
  const providerContinuity = suppliedProviderContinuity ?? new ProviderContinuity();

  const inputPlanner = new SessionInputPlanner({
    settingsService,
    agentClient,
    toolTracker,
    providerContinuity,
    getProviderHistorySnapshot: () => conversationStore.getProviderHistorySnapshot(),
    getHistoryIdentity: () => conversationStore.getProviderHistoryIdentity().identity,
  });

  const journal = new AssistantTurnJournal({
    getCurrentTurnId: () => toolTracker.getCurrentTurnId(),
  });

  const conversationLogger = new ConversationLogger({
    turnAccumulator: resolvedTurnAccumulator,
    logger,
    getAssistantTurnState: () => {
      const fn = getMethod<[], string>(agentClient, 'getProvider');
      const provider = fn ? fn.call(agentClient) : settingsService?.get('agent.provider');
      const model = settingsService?.get('agent.model');
      return {
        previousResponseId: providerContinuity.previousResponseId,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      } satisfies AssistantTurnState;
    },
    getCurrentTurnId: () => toolTracker.getCurrentTurnId(),
    getToolLedger: () => toolTracker.export(),
    journal,
  });
  openAIRootFreshTurnSelectorParityObserver?.setEvidenceRecorder?.((evidence) => {
    try {
      conversationLogger.log(evidence);
    } catch {
      // Selector-parity diagnostics must never affect the request path.
    }
  });
  openAIRootCheckpointLifecycleObserver?.setEvidenceRecorder?.((evidence) => {
    try {
      conversationLogger.log(evidence);
    } catch {
      // Checkpoint lifecycle diagnostics must never affect the stream path.
    }
  });

  // Background lifecycle belongs to the conversation-scoped sink, not the
  // active turn's UI sink. Both async subagents and root shell jobs use the
  // same projection and delivery queue, while their concrete registries retain
  // process/run ownership.
  const recordBackgroundEvent = (event: ConversationEvent) => {
    conversationLogger.dispatchEventToLog(event);
    if (notificationStore.recordLifecycle(event)) {
      try {
        taskObserver?.();
      } catch (error) {
        logger.warn('Background subagent task observer threw', {
          eventType: 'subagent.task_observer_failed',
          category: 'subagent',
          sessionId: id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
    syncPublicStatus();
    if (!notificationStore.enqueue(event)) return;
    try {
      notificationObserver?.();
    } catch (error) {
      logger.warn('Background subagent notification observer threw', {
        eventType: 'subagent.notification_observer_failed',
        category: 'subagent',
        sessionId: id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  };
  resolvedSubagentEventSinkHost?.setBackgroundSubagentEventSink?.(recordBackgroundEvent);
  resolvedSubagentEventSinkHost?.setBackgroundSubagentApprovalPauseSink?.(backgroundSubagentApprovals.publish);
  resolvedBackgroundShellEventSinkHost?.setBackgroundShellEventSink?.(recordBackgroundEvent);

  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient,
    approvalState,
    logger,
    sessionId: id,
    toolTracker,
    generationGuard,
    toolOwnership,
    sessionAccess,
    hookLifecycle,
    hookEvents,
    toolCallMarkers,
  });

  const continuityReset = new SessionContinuityReset({
    providerContinuity,
    approvalFlow,
    toolTracker,
    shellAutoApproval,
    inputPlanner,
    turnAccumulator: resolvedTurnAccumulator,
    agentClient,
  });

  // eslint-disable-next-line prefer-const
  let terminateActiveTurn: (() => void) | undefined;
  const state = new SessionLifecycle({
    inputPlanner,
    toolTracker,
    conversationStore,
    logger,
    sessionId: id,
    appState,
    providerContinuity,
    generationGuard,
    continuityReset,
    sessionAccess,
    terminateActiveTurn: () => terminateActiveTurn?.(),
  });

  let publicStatus: import('../hooks/hook-contracts.js').Term2Status = 'idle';
  const computePublicStatus = (): import('../hooks/hook-contracts.js').Term2Status => {
    const current = appState.statusMachine.current;
    if (current === 'awaiting_approval') {
      const pending = approvalFlow.getPending();
      const pendingTool = pending ? getToolInfoFromInterruption(pending.interruption).toolName : undefined;
      return pendingTool === 'ask_user' ? 'waiting_for_user' : 'waiting_for_approval';
    }
    if (current !== 'idle') {
      return 'working';
    }
    if (backgroundSubagentApprovals.getSnapshot().pendingCount > 0) {
      return 'waiting_for_approval';
    }
    const backgroundDetails = backgroundTaskControl.listDetails();
    for (const detail of backgroundDetails) {
      if (detail.kind === 'subagent') {
        if (detail.status === 'awaiting_approval') {
          return 'waiting_for_approval';
        }
        if (detail.status === 'waiting_for_answer') {
          return 'waiting_for_user';
        }
        if (detail.status === 'running' || detail.status === 'cancelling') {
          return 'working';
        }
      } else if (detail.kind === 'shell') {
        if (detail.status === 'running' || detail.status === 'cancelling') {
          return 'working';
        }
      }
    }
    return 'idle';
  };

  syncPublicStatus = (): void => {
    if (disposed || !hookLifecycle || !hookEvents) return;
    const next = computePublicStatus();
    if (next === publicStatus) return;
    const previous = publicStatus;
    publicStatus = next;
    void hookLifecycle.emit(
      hookEvents.create('status.change', {
        previous,
        current: next,
        reason:
          next === 'waiting_for_user'
            ? 'ask_user'
            : next === 'waiting_for_approval'
            ? 'approval_requested'
            : next === 'idle'
            ? 'turn_finished'
            : 'turn_started',
      }),
    );
  };

  appState.statusMachine.setObserver(() => {
    syncPublicStatus();
  });
  backgroundSubagentApprovals.subscribe(() => {
    syncPublicStatus();
  });

  const streamProcessor = new SessionStreamProcessor({
    logger,
    sessionId: id,
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    openAIRootCheckpointLifecycleObserver,
    generationGuard,
    journal,
    abortStream: () => agentClient.abort(),
    toolCallMarkers,
  });

  const breakChaining = (): void => {
    providerContinuity.breakChaining();
    logger.warn('WS-to-HTTP downgrade detected: chaining disabled, switching to full-history mode', {
      eventType: 'conversation.chaining_broken',
      category: 'provider',
      phase: 'post_stream',
      sessionId: id,
    });
  };

  const recoveryPolicy = new DefaultConversationRecoveryPolicy();
  const recoveryExecutor = new DefaultRecoveryExecutor({
    toolTracker,
    conversationStore,
    providerContinuity,
  });
  const retryClassifier = new DefaultRetryClassifier(agentClient);
  const retryEventPresenter = new RetryEventPresenter();
  const resolveRetryLimit = (): number => {
    const configured = settingsService?.get('agent.retryAttempts');
    if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 0) {
      return configured;
    }
    return 2;
  };
  const attemptFactory = new TurnAttemptFactory({
    agentClient,
    conversationStore,
    generationGuard,
    toolTracker,
    state,
    resolveRetryLimit,
    journal,
  });
  const inputPreparer = new InitialInputPreparer({
    conversationStore,
    generationGuard,
    inputPlanner,
    logger,
    sessionId: id,
    state,
  });
  const recoveryHandler = new InitialTurnRecoveryHandler({
    breakChaining,
    conversationStore,
    freshStartRetriesAllowed: retryOptions?.allowFreshStartRetries ?? true,
    generationGuard,
    inputPlanner,
    logger,
    recoveryExecutor,
    recoveryPolicy,
    retryClassifier,
    retryEventPresenter,
    sessionId: id,
  });

  const planApplier = new ContinuationPlanApplier({
    approvalFlow,
    toolTracker,
    logger,
    sessionId: id,
    journal,
  });

  const continuationRecoveryHandler = new ContinuationRecoveryHandler({
    breakChaining,
    logger,
    sessionId: id,
    generationGuard,
    retryClassifier,
    recoveryPolicy,
    recoveryExecutor,
    retryEventPresenter,
    resolveRetryLimit,
    toolTracker,
  });

  const turnWorkflow = new TurnWorkflow({
    agentClient,
    logger,
    sessionId: id,
    turnAccumulator: resolvedTurnAccumulator,
    toolTracker,
    shellAutoApproval,
    generationGuard,
    attemptFactory,
    inputPreparer,
    streamProcessor,
    recoveryHandler,
    journal,
    inputPlanner,
    conversationStore,
    approvalFlow,
    planApplier,
    continuationRecoveryHandler,
    providerContinuity,
    openAIRootFreshTurnSelectorParityObserver,
    sessionAccess,
    postExecutePending,
    setActivePostExecuteRunId: postExecutePauseCapability?.setActiveRunId.bind(postExecutePauseCapability),
    toolCallMarkers,
    hookLifecycle,
    hookEvents,
  });

  const turnCoordinator = new TurnCoordinator({
    statusMachine: appState.statusMachine,
    turnWorkflow,
    approvalFlow,
    providerContinuity,
    shellAutoApproval,
    sessionId: id,
    hookLifecycle,
    hookEvents,
  });
  terminateActiveTurn = () => turnCoordinator.terminate();

  const stateFacade = new SessionManager({
    conversationStore,
    toolTracker,
    state,
    conversationLogger,
    agentClient,
    settingsService,
    inputPlanner,
  });

  const runtimeController = new SessionRuntimeController({
    agentClient,
    state,
  });

  let backgroundShellSettlement: Promise<void> | undefined;
  let backgroundSubagentSettlement: Promise<void> | undefined;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    turnWorkflow.abortLiveRun();
    postExecutePending.close();
    generationGuard.invalidate();
    // Abort any active SDK work only if a turn is currently running.
    if (!appState.statusMachine.is('idle')) {
      approvalFlow.abort();
      appState.statusMachine.abort();
    }
    // Background subagent runs are bound to the conversation, not to a turn,
    // so they must be cancelled even when no turn is in flight.
    getMethod<[], void>(agentClient, 'cancelBackgroundRuns')?.call(agentClient);
    getMethod<[], void>(agentClient, 'cancelBackgroundShellJobs')?.call(agentClient);
    getMethod<[], void>(agentClient, 'disposeShellChildren')?.call(agentClient);
    notificationObserver = null;
    taskObserver = null;
    const subagentDisposal = getMethod<[], Promise<void>>(agentClient, 'disposeBackgroundSubagents')?.call(agentClient);
    backgroundSubagentSettlement = subagentDisposal
      ? Promise.resolve(subagentDisposal).finally(() => {
          backgroundSubagentApprovals.close();
          resolvedSubagentEventSinkHost?.setBackgroundSubagentApprovalPauseSink?.(null);
          resolvedSubagentEventSinkHost?.setBackgroundSubagentEventSink?.(null);
        })
      : Promise.resolve().then(() => {
          backgroundSubagentApprovals.close();
          resolvedSubagentEventSinkHost?.setBackgroundSubagentApprovalPauseSink?.(null);
          resolvedSubagentEventSinkHost?.setBackgroundSubagentEventSink?.(null);
        });
    const shellDisposal = getMethod<[], Promise<void>>(agentClient, 'disposeBackgroundShellJobs')?.call(agentClient);
    backgroundShellSettlement = shellDisposal
      ? Promise.resolve(shellDisposal).finally(() =>
          resolvedBackgroundShellEventSinkHost?.setBackgroundShellEventSink?.(null),
        )
      : Promise.resolve().then(() => resolvedBackgroundShellEventSinkHost?.setBackgroundShellEventSink?.(null));
    providerContinuity.clear();
    pendingInteraction.clear();
  };

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      dispose();
      await backgroundShellSettlement;
      await backgroundSubagentSettlement;
      await hookLifecycle?.shutdown();
    })();
    return shutdownPromise;
  };

  const compactContext = async (options?: {
    signal?: AbortSignal;
  }): Promise<LocalCompactionOutcome | { kind: 'busy' | 'stale' }> => {
    if (!appState.statusMachine.is('idle')) return { kind: 'busy' };
    const snapshot = conversationStore.getProviderHistorySnapshot();
    const provider =
      getMethod<[], string>(agentClient, 'getProvider')?.call(agentClient) ??
      settingsService?.get('agent.provider') ??
      'openai';
    const model = settingsService?.get('agent.model') ?? 'gpt-5';
    const reasoningEffort = settingsService?.get('agent.reasoningEffort');
    const catalog = getCatalogModel(provider, model);
    const compactThreshold = settingsService?.get('agent.contextCompaction.compactThreshold') ?? 0.8;
    const configuredMaxOutput = settingsService?.get('agent.maxOutputTokens');
    const abortError = (): Error => {
      const error = new Error('Context compaction cancelled.');
      error.name = 'AbortError';
      return error;
    };
    const compactor = new LocalContextCompactor({
      generate: async ({ renderedInput, maxOutputTokens, signal }) => {
        if (signal?.aborted) throw abortError();
        const chatOptions = {
          provider,
          model,
          reasoningEffort,
          instructions: CONTEXT_COMPACTION_INSTRUCTIONS,
          maxTokens: maxOutputTokens,
        };
        const aborted = new Promise<never>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              getMethod<[], void>(agentClient, 'abort')?.call(agentClient);
              reject(abortError());
            },
            { once: true },
          );
        });
        const generate = async () => {
          if (agentClient.chatDetailed) {
            const result = await agentClient.chatDetailed(renderedInput, chatOptions);
            return {
              text: result.text,
              usage: result.usage
                ? {
                    inputTokens: result.usage.prompt_tokens,
                    outputTokens: result.usage.completion_tokens,
                  }
                : undefined,
              costRecords: result.costRecords,
            };
          }
          return { text: await agentClient.chat(renderedInput, chatOptions) };
        };
        return signal ? Promise.race([generate(), aborted]) : generate();
      },
    });
    const outcome = await compactor.compactAtBoundary({
      history: snapshot.history,
      provider,
      model,
      sourceRevision: snapshot.revision,
      contextWindow: catalog?.contextWindow,
      maxOutputTokens:
        configuredMaxOutput === undefined
          ? catalog?.maxTokens
          : Math.min(configuredMaxOutput, catalog?.maxTokens ?? configuredMaxOutput),
      compactThreshold,
      compactThresholdTokens: null,
      manual: true,
      signal: options?.signal,
    });
    if (outcome.kind !== 'compacted') return outcome;

    const genuineUsers = snapshot.history.filter((item) => {
      const message = projectConversationMessage(item);
      return message?.role === 'user' && !message.isSynthetic;
    });
    const hotUsers = outcome.hotTail.filter((item) => {
      const message = projectConversationMessage(item);
      return message?.role === 'user' && !message.isSynthetic;
    }).length;
    const preservedUsers = hotUsers === 0 ? genuineUsers : genuineUsers.slice(0, -hotUsers);
    if (
      !conversationStore.replaceHistoryAtRevision(snapshot.revision, [
        ...preservedUsers,
        outcome.checkpoint,
        ...outcome.hotTail,
      ])
    ) {
      return { kind: 'stale' };
    }
    providerContinuity.clear();
    return outcome;
  };

  return {
    sessionId: id,
    sessionStartedAt: startedAt,
    logger,
    conversationStore,
    approvalState,
    toolTracker,
    toolCallMarkers,
    shellAutoApproval,
    approvalFlow,
    inputPlanner,
    state,
    conversationLogger,
    streamProcessor,
    appState,
    turnCoordinator,
    stateFacade,
    runtimeController,
    dispose,
    shutdown,
    generationGuard,
    providerContinuity,
    breakChaining,
    compactContext,
    recoveryPolicy,
    recoveryExecutor,
    retryClassifier,
    retryEventPresenter,
    turnAccumulator: resolvedTurnAccumulator,
    turnWorkflow,
    freshStartRetriesAllowed: retryOptions?.allowFreshStartRetries ?? true,
    journal,
    resolvedAskUserAnswerSink,
    resolvedSubagentEventSinkHost,
    resolvedBackgroundShellEventSinkHost,
    backgroundSubagentNotifications,
    backgroundSubagentTasks,
    backgroundSubagentApprovals,
    backgroundTaskControl,
    postExecutePending,
    pendingInteraction,
  };
}

/** @internal Alias that keeps the narrow {@link ConversationSessionBundle} return type. */
export const createConversationSession: (options: CreateConversationSessionOptions) => ConversationSessionBundle =
  createSessionRuntimeInternals;

// ── Session Runtime Factory ───────────────────────────────────────

/** @internal Wraps a shared internals instance into the closed runtime. */
export function buildSessionRuntime(internals: SessionRuntimeInternals): SessionRuntime {
  const {
    turnCoordinator,
    stateFacade,
    runtimeController,
    conversationLogger,
    journal,
    dispose,
    approvalFlow,
    resolvedAskUserAnswerSink,
    resolvedSubagentEventSinkHost,
    backgroundSubagentNotifications,
    backgroundSubagentTasks,
    backgroundSubagentApprovals,
    backgroundTaskControl,
    postExecutePending,
    pendingInteraction,
  } = internals;

  return {
    sessionId: internals.sessionId,
    sessionStartedAt: internals.sessionStartedAt,
    turns: {
      start: turnCoordinator.start.bind(turnCoordinator),
      continueAfterApproval: turnCoordinator.continueAfterApproval.bind(turnCoordinator),
      continueAfterPostExecuteApproval: turnCoordinator.continueAfterPostExecuteApproval.bind(turnCoordinator),
      abort: turnCoordinator.abort.bind(turnCoordinator),
      steer: turnCoordinator.steer.bind(turnCoordinator),
      retractSteer: turnCoordinator.retractSteer.bind(turnCoordinator),
      editSteer: turnCoordinator.editSteer.bind(turnCoordinator),
    },
    state: stateFacade,
    settings: runtimeController,
    compactContext: internals.compactContext,
    logs: {
      setLogSink: (sink) => {
        conversationLogger.setLogSink(sink);
        journal.setSink(
          sink
            ? (event) => {
                try {
                  sink(event);
                } catch (err) {
                  internals.logger.warn('Journal sink threw', {
                    eventType: 'conversation_log.sink_failed',
                    category: 'persistence',
                    errorMessage: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            : null,
        );
      },
      dispatchEventToLog: conversationLogger.dispatchEventToLog.bind(conversationLogger),
      log: conversationLogger.log.bind(conversationLogger),
    },
    approval: {
      getPending: approvalFlow.getPending.bind(approvalFlow),
      getPendingInterruption: approvalFlow.getPendingInterruption.bind(approvalFlow),
      getPostExecutePending: postExecutePending.snapshot.bind(postExecutePending),
      decidePostExecutePending: postExecutePending.decide.bind(postExecutePending),
    },
    pendingInteraction,
    sinks: {
      askUserAnswer: resolvedAskUserAnswerSink,
      subagentEvents: resolvedSubagentEventSinkHost,
    },
    backgroundSubagentNotifications,
    backgroundSubagentTasks,
    backgroundSubagentApprovals,
    backgroundTaskControl,
    dispose,
    shutdown: internals.shutdown,
  };
}

/**
 * Creates a session runtime with a clean public API, without constructing
 * the conversation-layer adapter. Internal composition details remain private.
 */
export function createSessionRuntime(options: CreateConversationSessionOptions): SessionRuntime {
  const releaseRuntime = registerSessionRuntime();
  try {
    const runtime = buildSessionRuntime(
      createSessionRuntimeInternals({
        ...options,
        turnAccumulator: undefined,
      }),
    );
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      releaseRuntime();
    };
    const dispose = runtime.dispose;
    runtime.dispose = (): void => {
      try {
        dispose();
      } finally {
        releaseOnce();
      }
    };
    const shutdown = runtime.shutdown;
    runtime.shutdown = async (): Promise<void> => {
      try {
        await shutdown();
      } finally {
        releaseOnce();
      }
    };
    return runtime;
  } catch (error) {
    releaseRuntime();
    throw error;
  }
}
