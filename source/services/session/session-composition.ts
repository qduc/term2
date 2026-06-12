import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { ApprovalState } from '../approval/approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { getMethod } from '../interruption-info.js';
import { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import type { AssistantTurnState } from '../logging/conversation-log-events.js';
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
  turnAccumulator: TurnItemAccumulator;
};

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

  const conversationLogger = new ConversationLogger({
    turnAccumulator,
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
    getToolLedger: () => toolTracker.export(),
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
    turnAccumulator,
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
    turnAccumulator,
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

  const continuationDriver = new ContinuationDriver({
    agentClient,
    logger,
    sessionId: id,
    toolTracker,
    streamProcessor,
    approvalFlow,
    providerContinuity,
    inputPlanner,
    conversationStore,
    turnAccumulator,
    shellAutoApproval,
    generationGuard,
    retryClassifier,
    recoveryPolicy,
    recoveryExecutor,
    retryEventPresenter,
    resolveRetryLimit,
  });

  const initialTurnRunner = new InitialTurnRunner({
    agentClient,
    logger,
    sessionId: id,
    turnAccumulator,
    toolTracker,
    shellAutoApproval,
    continuationDriver,
    generationGuard,
    attemptFactory,
    inputPreparer,
    streamCycle,
    recoveryHandler,
  });

  const turnCoordinator = new TurnCoordinator({
    statusMachine: appState.statusMachine,
    initialTurnRunner,
    continuationDriver,
    approvalFlow,
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

  // terminalAdapter wires directly to turnCoordinator — no callback through ConversationSession.
  const terminalAdapter = new ConversationAdapter({
    sessionId: id,
    startedAt,
    askUserAnswerSink,
    subagentEventSinkHost,
    logger,
    settingsService,
    sessionContextService,
    conversationStore,
    conversationLogger,
    approvalFlow,
    run: (input, opts) => turnCoordinator.start(input, opts),
    continueAfterApproval: (opts) => turnCoordinator.continueAfterApproval(opts),
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
    turnAccumulator,
    initialTurnRunner,
    freshStartRetriesAllowed: retryOptions?.allowFreshStartRetries ?? true,
  };
}
