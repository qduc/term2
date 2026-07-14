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
import { sessionReadAccess } from '../approval/session-read-access.js';
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
};

// ── Options for the composition factory ──────────────────────────

/** @internal Options for the internal composition factory. */
export type CreateSessionRuntimeInternalsOptions = {
  sessionId: string;
  /** ISO timestamp; defaults to now. */
  sessionStartedAt?: string;
  agentClient: ConversationAgentClient;
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
    abort: () => void;
  };
  /** Facade for state/persistence/undo/snapshot operations. */
  state: SessionManager;
  /** Controller for runtime model/provider/retry settings. */
  settings: SessionRuntimeController;
  logs: SessionLogs;
  approval: SessionApprovalQuery;
  sinks: SessionSinks;
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

  const generationGuard = new GenerationGuard();

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
  const providerContinuity = new ProviderContinuity();

  const inputPlanner = new SessionInputPlanner({
    settingsService,
    agentClient,
    toolTracker,
    providerContinuity,
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

  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient,
    approvalState,
    logger,
    sessionId: id,
    toolTracker,
    generationGuard,
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
    generationGuard.invalidate();
    // Abort any active SDK work only if a turn is currently running.
    if (!appState.statusMachine.is('idle')) {
      approvalFlow.abort();
      appState.statusMachine.abort();
    }
    providerContinuity.clear();
    sessionReadAccess.clear(id);
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
  } = internals;

  return {
    sessionId: internals.sessionId,
    sessionStartedAt: internals.sessionStartedAt,
    turns: {
      start: turnCoordinator.start.bind(turnCoordinator),
      continueAfterApproval: turnCoordinator.continueAfterApproval.bind(turnCoordinator),
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
    },
    sinks: {
      askUserAnswer: resolvedAskUserAnswerSink,
      subagentEvents: resolvedSubagentEventSinkHost,
    },
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
