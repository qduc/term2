import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { ApprovalState, type PendingApprovalContext } from '../approval/approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { getMethod } from '../interruption-info.js';
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
import type { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import {
  PostExecutePendingRegistry,
  type PostExecuteDecisionRequest,
  type PostExecuteDecisionResult,
  type PostExecutePendingSnapshot,
} from './post-execute-pending-registry.js';
import type { PostExecutePauseCapability } from './post-execute-pause-capability.js';
import type { SessionAccessState } from './session-access-state.js';

const asAskUserAnswerSink = (value: unknown): AskUserAnswerSink | null =>
  value && typeof (value as AskUserAnswerSink).setAskUserAnswer === 'function' ? (value as AskUserAnswerSink) : null;

const asSubagentEventSinkHost = (value: unknown): SubagentEventSinkHost | null =>
  value && typeof (value as SubagentEventSinkHost).setSubagentEventSink === 'function'
    ? (value as SubagentEventSinkHost)
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
  generationGuard: GenerationGuard;
  providerContinuity: ProviderContinuity;
  breakChaining: () => void;
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
  /** Completions of background subagent runs still owed to the main agent. */
  backgroundSubagentNotifications: BackgroundSubagentNotificationChannel;
  /** Read-only lifecycle projection for background subagent UI. */
  backgroundSubagentTasks: BackgroundSubagentTaskChannel;
  /** Session-owned fail-closed gates for post-execute policies. */
  postExecutePending: PostExecutePendingRegistry;
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
    continueAfterApproval: (options: { answer: string; rejectionReason?: string }) => AsyncIterable<ConversationEvent>;
    continueAfterPostExecuteApproval: () => AsyncIterable<ConversationEvent>;
    abort: () => void;
  };
  /** Facade for state/persistence/undo/snapshot operations. */
  state: SessionManager;
  /** Controller for runtime model/provider/retry settings. */
  settings: SessionRuntimeController;
  logs: SessionLogs;
  approval: SessionApprovalQuery;
  sinks: SessionSinks;
  /** Completions of background subagent runs still owed to the main agent. */
  backgroundSubagentNotifications: BackgroundSubagentNotificationChannel;
  /** Read-only lifecycle projection for background subagent UI. */
  backgroundSubagentTasks: BackgroundSubagentTaskChannel;
  /**
   * Idempotent disposal: aborts active SDK work, invalidates the active
   * generation, unsubscribes downgrade listeners, clears per-turn state.
   */
  dispose: () => void;
};

// ── Composition factory ───────────────────────────────────────────

export function createSessionRuntimeInternals(options: CreateSessionRuntimeInternalsOptions): SessionRuntimeInternals {
  const {
    sessionId: id,
    sessionStartedAt,
    agentClient,
    providerContinuity: suppliedProviderContinuity,
    toolOwnership,
    postExecutePending: suppliedPostExecutePending,
    postExecutePauseCapability,
    sessionAccess,
    askUserAnswerSink,
    subagentEventSinkHost,
    deps,
    retryOptions,
    turnAccumulator,
  } = options;
  const { logger, settingsService, sessionContextService } = deps;
  const startedAt = sessionStartedAt ?? new Date().toISOString();
  const resolvedTurnAccumulator = turnAccumulator ?? new TurnItemAccumulator();
  const resolvedAskUserAnswerSink = askUserAnswerSink ?? asAskUserAnswerSink(agentClient);
  const resolvedSubagentEventSinkHost = subagentEventSinkHost ?? asSubagentEventSinkHost(agentClient);

  // Background (async) subagent runs settle whenever they settle, including
  // while the conversation is idle and no per-turn sink is attached.
  const notificationStore = new SubagentNotificationStore();
  let notificationObserver: (() => void) | null = null;
  let taskObserver: (() => void) | null = null;
  const backgroundSubagentNotifications: BackgroundSubagentNotificationChannel = {
    get pendingCount() {
      return notificationStore.pendingCount;
    },
    drain: () => notificationStore.drain(),
    retain: (notifications) => notificationStore.retain(notifications),
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

  const generationGuard = new GenerationGuard();
  // Factory-owned handles supply this same registry to the root tool policy.
  // Compatibility callers receive a fresh explicit token, never a wall-clock epoch.
  const postExecutePending =
    suppliedPostExecutePending ?? new PostExecutePendingRegistry({ sessionId: id, epoch: crypto.randomUUID() });

  const conversationStore = new ConversationStore();
  const approvalState = new ApprovalState();
  const toolTracker = new SessionToolTracker(conversationStore);

  const shellAutoApproval = new DelegatingShellAutoApprovalResolver({
    conversationStore,
    agentClient,
    logger,
    settingsService,
    sessionContextService,
  });

  const appState = { statusMachine: new TurnStatusMachine() };
  const providerContinuity = suppliedProviderContinuity ?? new ProviderContinuity();

  const inputPlanner = new SessionInputPlanner({
    settingsService,
    agentClient,
    toolTracker,
    providerContinuity,
    getProviderHistorySnapshot: () => conversationStore.getProviderHistorySnapshot(),
  });

  const journal = new AssistantTurnJournal({
    getCurrentTurnId: () => toolTracker.getCurrentTurnId(),
  });

  const conversationLogger = new ConversationLogger({
    turnAccumulator: resolvedTurnAccumulator,
    logger,
    getAssistantTurnState: () => {
      const fn = getMethod<[], string>(agentClient, 'getProvider');
      const provider = fn ? fn.call(agentClient) : settingsService?.get<string>('agent.provider');
      const model = settingsService?.get<string>('agent.model');
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

  // Background lifecycle belongs to the conversation-scoped sink, not the
  // active turn's UI sink. Dispatch it through conversation logging, while only
  // terminal async events enter the main-agent notification queue.
  resolvedSubagentEventSinkHost?.setBackgroundSubagentEventSink?.((event) => {
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
  });

  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient,
    approvalState,
    logger,
    sessionId: id,
    toolTracker,
    generationGuard,
    toolOwnership,
    sessionAccess,
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
  });

  const streamProcessor = new SessionStreamProcessor({
    logger,
    sessionId: id,
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    journal,
    abortStream: () => agentClient.abort(),
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
    const configured = settingsService?.get<number>('agent.retryAttempts');
    if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 0) {
      return configured;
    }
    const clientLimit = getMethod<[], number>(agentClient, 'getStreamMaxRetries')?.call(agentClient);
    return typeof clientLimit === 'number' && Number.isInteger(clientLimit) && clientLimit >= 0 ? clientLimit : 2;
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
    sessionAccess,
    postExecutePending,
    setActivePostExecuteRunId: postExecutePauseCapability?.setActiveRunId.bind(postExecutePauseCapability),
  });

  const turnCoordinator = new TurnCoordinator({
    statusMachine: appState.statusMachine,
    turnWorkflow,
    approvalFlow,
    providerContinuity,
  });

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

  let disposed = false;
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
    notificationObserver = null;
    taskObserver = null;
    resolvedSubagentEventSinkHost?.setBackgroundSubagentEventSink?.(null);
    providerContinuity.clear();
  };

  return {
    sessionId: id,
    sessionStartedAt: startedAt,
    logger,
    conversationStore,
    approvalState,
    toolTracker,
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
    generationGuard,
    providerContinuity,
    breakChaining,
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
    backgroundSubagentNotifications,
    backgroundSubagentTasks,
    postExecutePending,
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
    postExecutePending,
  } = internals;

  return {
    sessionId: internals.sessionId,
    sessionStartedAt: internals.sessionStartedAt,
    turns: {
      start: turnCoordinator.start.bind(turnCoordinator),
      continueAfterApproval: turnCoordinator.continueAfterApproval.bind(turnCoordinator),
      continueAfterPostExecuteApproval: turnCoordinator.continueAfterPostExecuteApproval.bind(turnCoordinator),
      abort: turnCoordinator.abort.bind(turnCoordinator),
    },
    state: stateFacade,
    settings: runtimeController,
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
    sinks: {
      askUserAnswer: resolvedAskUserAnswerSink,
      subagentEvents: resolvedSubagentEventSinkHost,
    },
    backgroundSubagentNotifications,
    backgroundSubagentTasks,
    dispose,
  };
}

/**
 * Creates a session runtime with a clean public API, without constructing
 * the conversation-layer adapter. Internal composition details remain private.
 */
export function createSessionRuntime(options: CreateConversationSessionOptions): SessionRuntime {
  return buildSessionRuntime(
    createSessionRuntimeInternals({
      ...options,
      turnAccumulator: undefined,
    }),
  );
}
