import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { ApprovalState } from '../approval/approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { getMethod } from '../interruption-info.js';
import { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import type { AssistantTurnState, LogEvent } from '../logging/conversation-log-events.js';
import type {
  AskUserAnswerSink,
  ConversationAgentClient,
  SubagentEventSinkHost,
} from '../conversation-agent-client.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { ProviderContinuity } from '../provider-continuity.js';
import { TurnCoordinator } from './turn-coordinator.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { SessionManager } from './session-manager.js';
import { SessionRuntimeController } from './session-runtime-controller.js';
import { ConversationAdapter } from '../conversation/conversation-adapter.js';
import { ContinuationDriver } from './continuation-driver.js';
import { ContinuationPlanApplier } from './continuation-plan-applier.js';
import { ContinuationStreamCycle } from './continuation-stream-cycle.js';
import { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';
import { DefaultConversationRecoveryPolicy } from '../retry/recovery-policy.js';
import { DefaultRecoveryExecutor } from '../retry/recovery-executor.js';
import { GenerationGuard } from '../generation-guard.js';
import { DefaultRetryClassifier } from '../retry/retry-classifier.js';
import { RetryEventPresenter } from '../retry/retry-event-presenter.js';
import { InitialTurnRunner } from './initial-turn-runner.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import { TurnAttemptFactory } from './turn-attempt-factory.js';
import { InitialInputPreparer } from './initial-input-preparer.js';
import { InitialStreamCycle } from './initial-stream-cycle.js';
import { InitialTurnRecoveryHandler } from './initial-turn-recovery-handler.js';
import { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';

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

/** All collaborator instances created by the composition factory. */
export type ConversationSessionComposition = {
  sessionId: string;
  sessionStartedAt: string;
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
  /** Adapter that provides the legacy sendMessage/handleApprovalDecision surface. */
  terminalAdapter: ConversationAdapter;
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
  continuationDriver: ContinuationDriver;
  recoveryPolicy: DefaultConversationRecoveryPolicy;
  recoveryExecutor: DefaultRecoveryExecutor;
  retryClassifier: DefaultRetryClassifier;
  retryEventPresenter: RetryEventPresenter;
  turnAccumulator: TurnItemAccumulator;
  initialTurnRunner: InitialTurnRunner;
  freshStartRetriesAllowed: boolean;
  /**
   * Lazily constructs the assistant turn journal once a log sink is
   * available. Idempotent: subsequent calls return the same journal.
   */
  ensureJournal: (sink: (event: LogEvent) => void) => AssistantTurnJournal;
};

// ── Options for the composition factory ──────────────────────────

export type CreateConversationSessionCompositionOptions = {
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

export type CreateConversationSessionOptions = Omit<CreateConversationSessionCompositionOptions, 'turnAccumulator'>;
export type ConversationSessionBundle = Pick<
  ConversationSessionComposition,
  | 'sessionId'
  | 'sessionStartedAt'
  | 'turnCoordinator'
  | 'terminalAdapter'
  | 'stateFacade'
  | 'runtimeController'
  | 'conversationLogger'
  | 'approvalState'
  | 'shellAutoApproval'
  | 'toolTracker'
  | 'inputPlanner'
  | 'dispose'
  | 'ensureJournal'
>;

// ── Composition factory ───────────────────────────────────────────

export function createConversationSessionComposition(
  options: CreateConversationSessionCompositionOptions,
): ConversationSessionComposition {
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

  let currentShellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient,
    logger,
    settingsService,
    sessionContextService,
  });

  const shellAutoApproval = new Proxy(
    {},
    {
      get(_target, prop, receiver) {
        if (prop === 'setDelegate') {
          return (newDelegate: ShellAutoApprovalResolver) => {
            currentShellAutoApproval = newDelegate;
          };
        }
        return Reflect.get(currentShellAutoApproval, prop, receiver);
      },
    },
  ) as unknown as ShellAutoApprovalResolver;

  const appState = { statusMachine: new TurnStatusMachine() };
  const providerContinuity = new ProviderContinuity();

  const inputPlanner = new SessionInputPlanner({
    settingsService,
    agentClient,
    toolTracker,
    providerContinuity,
  });

  let journal: AssistantTurnJournal | null = null;

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
    getJournal: () => journal ?? undefined,
  });

  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient,
    approvalState,
    logger,
    sessionId: id,
    toolTracker,
    generationGuard,
  });

  const state = new SessionLifecycle({
    inputPlanner,
    approvalFlow,
    toolTracker,
    shellAutoApproval,
    turnAccumulator: resolvedTurnAccumulator,
    conversationStore,
    agentClient,
    logger,
    sessionId: id,
    appState,
    providerContinuity,
    generationGuard,
  });

  const streamProcessor = new SessionStreamProcessor({
    logger,
    sessionId: id,
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    getJournal: () => journal ?? undefined,
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
  });
  const inputPreparer = new InitialInputPreparer({
    conversationStore,
    generationGuard,
    inputPlanner,
    logger,
    sessionId: id,
    state,
  });
  const streamCycle = new InitialStreamCycle({
    agentClient,
    approvalFlow,
    conversationStore,
    inputPlanner,
    logger,
    providerContinuity,
    sessionId: id,
    shellAutoApproval,
    streamProcessor,
    toolTracker,
    turnAccumulator: resolvedTurnAccumulator,
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
  });

  const continuationStreamCycle = new ContinuationStreamCycle({
    agentClient,
    streamProcessor,
    conversationStore,
    turnAccumulator: resolvedTurnAccumulator,
    toolTracker,
    approvalFlow,
    shellAutoApproval,
    logger,
    sessionId: id,
    providerContinuity,
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

  const continuationDriver = new ContinuationDriver({
    generationGuard,
    logger,
    sessionId: id,
    shellAutoApproval,
    inputPlanner,
    conversationStore,
    approvalFlow,
    planApplier,
    streamCycle: continuationStreamCycle,
    recoveryHandler: continuationRecoveryHandler,
    toolTracker,
  });

  const initialTurnRunner = new InitialTurnRunner({
    agentClient,
    logger,
    sessionId: id,
    turnAccumulator: resolvedTurnAccumulator,
    toolTracker,
    shellAutoApproval,
    generationGuard,
    attemptFactory,
    inputPreparer,
    streamCycle,
    recoveryHandler,
    getJournal: () => journal ?? undefined,
  });

  const turnCoordinator = new TurnCoordinator({
    statusMachine: appState.statusMachine,
    initialTurnRunner,
    continuationDriver,
    approvalFlow,
    shellAutoApproval,
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

  const ensureJournal = (sink: (event: LogEvent) => void): AssistantTurnJournal => {
    if (!journal) {
      journal = new AssistantTurnJournal({
        getCurrentTurnId: () => toolTracker.getCurrentTurnId(),
        sink: (event) => {
          try {
            sink(event);
          } catch (err) {
            logger.warn('Journal sink threw', {
              eventType: 'conversation_log.sink_failed',
              category: 'persistence',
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }
        },
      });
    }
    return journal;
  };

  const runtimeController = new SessionRuntimeController({
    agentClient,
    state,
  });

  // terminalAdapter wires directly to turnCoordinator — no callback through ConversationSession.
  const terminalAdapter = new ConversationAdapter({
    sessionId: id,
    startedAt,
    askUserAnswerSink: resolvedAskUserAnswerSink,
    subagentEventSinkHost: resolvedSubagentEventSinkHost,
    logger,
    settingsService,
    sessionContextService,
    conversationStore,
    conversationLogger,
    approvalFlow,
    turnFlow: turnCoordinator,
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
  };

  return {
    sessionId: id,
    sessionStartedAt: startedAt,
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
    terminalAdapter,
    stateFacade,
    runtimeController,
    dispose,
    generationGuard,
    providerContinuity,
    breakChaining,
    continuationDriver,
    recoveryPolicy,
    recoveryExecutor,
    retryClassifier,
    retryEventPresenter,
    turnAccumulator: resolvedTurnAccumulator,
    initialTurnRunner,
    freshStartRetriesAllowed: retryOptions?.allowFreshStartRetries ?? true,
    ensureJournal,
  };
}

export const createConversationSession: (options: CreateConversationSessionOptions) => ConversationSessionBundle =
  createConversationSessionComposition;
