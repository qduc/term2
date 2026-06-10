import type { ILoggingService, ISessionContextService, ISettingsService } from './service-interfaces.js';
import { ConversationStore } from './conversation-store.js';
import { SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import { ApprovalState } from './approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { getMethod } from './interruption-info.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from './conversation-logger.js';
import type { AssistantTurnState } from './conversation-log-events.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { ProviderContinuity } from './provider-continuity.js';
import { TurnCoordinator, TurnState } from './turn-coordinator.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { SessionManager } from './session-manager.js';
import { SessionRuntimeController } from './session-runtime-controller.js';
import { ConversationAdapter } from './conversation-adapter.js';
import { ContinuationDriver } from './continuation-driver.js';
import { DefaultConversationRecoveryPolicy } from './recovery-policy.js';
import { DefaultRecoveryExecutor } from './recovery-executor.js';

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
  retryOrchestrator: SessionRetryOrchestrator;
  inputPlanner: SessionInputPlanner;
  state: SessionLifecycle;
  conversationLogger: ConversationLogger;
  streamProcessor: SessionStreamProcessor;
  appState: TurnState;
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
};

// ── Options for the composition factory ──────────────────────────

export type CreateConversationSessionCompositionOptions = {
  sessionId: string;
  /** ISO timestamp; defaults to now. */
  sessionStartedAt?: string;
  agentClient: ConversationAgentClient;
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
  const { sessionId: id, sessionStartedAt, agentClient, deps, retryOptions, turnAccumulator } = options;
  const { logger, settingsService, sessionContextService } = deps;
  const startedAt = sessionStartedAt ?? new Date().toISOString();

  const conversationStore = new ConversationStore();
  const approvalState = new ApprovalState();
  const toolTracker = new SessionToolTracker(conversationStore);

  const retryOrchestrator = new SessionRetryOrchestrator(
    logger,
    id,
    agentClient,
    retryOptions?.allowFreshStartRetries ?? true,
  );

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

  const appState = new TurnState();
  const providerContinuity = new ProviderContinuity();

  const inputPlanner = new SessionInputPlanner({
    settingsService,
    agentClient,
    toolTracker,
    providerContinuity,
  });

  const state = new SessionLifecycle({
    retryOrchestrator,
    inputPlanner,
    approvalState,
    toolTracker,
    shellAutoApproval,
    turnAccumulator,
    conversationStore,
    agentClient,
    logger,
    sessionId: id,
    appState,
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
  });

  const streamProcessor = new SessionStreamProcessor({
    logger,
    sessionId: id,
    toolTracker,
    conversationStore,
    conversationLogger,
    retryOrchestrator,
    providerContinuity,
  });

  // breakChaining is a local closure — no callback back into ConversationSession.
  const breakChaining = (): void => {
    retryOrchestrator.breakChaining();
    providerContinuity.breakChaining();
    logger.warn('WS-to-HTTP downgrade detected: chaining disabled, switching to full-history mode', {
      eventType: 'conversation.chaining_broken',
      category: 'provider',
      phase: 'post_stream',
      sessionId: id,
    });
  };

  const continuationDriver = new ContinuationDriver({
    agentClient,
    logger,
    sessionId: id,
    toolTracker,
    streamProcessor,
    approvalFlow,
    retryOrchestrator,
    providerContinuity,
    inputPlanner,
    conversationStore,
    turnAccumulator,
    shellAutoApproval,
  });

  const recoveryPolicy = new DefaultConversationRecoveryPolicy();
  const recoveryExecutor = new DefaultRecoveryExecutor({
    toolTracker,
    conversationStore,
    providerContinuity,
  });

  const turnCoordinator = new TurnCoordinator({
    agentClient,
    logger,
    sessionId: id,
    turnAccumulator,
    retryOrchestrator,
    toolTracker,
    conversationStore,
    conversationLogger,
    approvalFlow,
    shellAutoApproval,
    inputPlanner,
    state,
    streamProcessor,
    appState,
    providerContinuity,
    breakChaining,
    continuationDriver,
    recoveryPolicy,
    recoveryExecutor,
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
    agentClient,
    logger,
    settingsService,
    sessionContextService,
    conversationStore,
    conversationLogger,
    approvalFlow,
    run: (input, opts) => turnCoordinator.start(input, opts),
    continueAfterApproval: (opts) => turnCoordinator.continueAfterApproval(opts),
  });

  // Subscribe to transport downgrade events; store unsubscribe handle for disposal.
  let unsubscribeDowngrade: (() => void) | undefined;
  if (typeof agentClient.onDowngrade === 'function') {
    const result = agentClient.onDowngrade(() => breakChaining());
    if (typeof result === 'function') {
      unsubscribeDowngrade = result;
    }
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    // Abort any active SDK work only if a turn is currently running.
    if (!appState.statusMachine.is('idle')) {
      if (typeof agentClient.abort === 'function') {
        agentClient.abort();
      }
      approvalState.abortPending();
      appState.statusMachine.abort();
    }
    retryOrchestrator.breakChaining();
    providerContinuity.clear();
    unsubscribeDowngrade?.();
  };

  return {
    conversationStore,
    approvalState,
    toolTracker,
    shellAutoApproval,
    approvalFlow,
    retryOrchestrator,
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
  };
}
