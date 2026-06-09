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
import type { ConversationEvent } from './conversation-events.js';
import type { ConversationTerminal } from '../contracts/conversation.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { AgentStream } from './agent-stream.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionStateController } from './session-state-controller.js';
import { ApprovalContinuationRunner } from './approval-continuation-runner.js';
import { ConversationTurnRunner } from './conversation-turn-runner.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import type { UserTurn } from '../types/user-turn.js';

// ── Public types ──────────────────────────────────────────────────

export type ConversationSessionRetryOptions = {
  /**
   * When false, retries are only allowed if an AgentStream exists so the turn
   * can resume from captured history instead of replaying from the beginning.
   */
  allowFreshStartRetries?: boolean;
};

/** AsyncGenerator callback for buildAndResolve. */
export type BuildAndResolveFn = (
  result: AgentStream,
  finalOutputOverride: string | undefined,
  reasoningOutputOverride: string | undefined,
  emittedCommandIds: Set<string> | undefined,
  usage: NormalizedUsage | undefined,
) => AsyncGenerator<ConversationEvent, ConversationTerminal, void>;

/** Callback for restarting a turn. */
export type RestartTurnFn = (
  turn: { text: string; images?: UserTurn['images'] },
  options: { skipUserMessage?: boolean; retries?: { transientRetryCount?: number } },
) => AsyncIterable<ConversationEvent>;

/** All collaborator instances created by the composition factory. */
export type ConversationSessionComposition = {
  conversationStore: ConversationStore;
  approvalState: ApprovalState;
  toolTracker: SessionToolTracker;
  shellAutoApproval: ShellAutoApprovalResolver;
  approvalFlow: ApprovalFlowCoordinator;
  retryOrchestrator: SessionRetryOrchestrator;
  inputPlanner: SessionInputPlanner;
  state: SessionStateController;
  conversationLogger: ConversationLogger;
  streamProcessor: SessionStreamProcessor;
  continuationRunner: ApprovalContinuationRunner;
  turnRunner: ConversationTurnRunner;
};

// ── Options for the factory ───────────────────────────────────────

export type CreateConversationSessionCompositionOptions = {
  sessionId: string;
  agentClient: ConversationAgentClient;
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
  retryOptions?: ConversationSessionRetryOptions;
  turnAccumulator: TurnItemAccumulator;

  /** Callbacks that wire back into the owning session. */
  callbacks: {
    breakChaining: () => void;
    buildAndResolve: BuildAndResolveFn;
    restartTurn: RestartTurnFn;
    isCurrentGeneration: (gen: number) => boolean;
  };
};

// ── Factory function ──────────────────────────────────────────────

export function createConversationSessionComposition(
  options: CreateConversationSessionCompositionOptions,
): ConversationSessionComposition {
  const { sessionId: id, agentClient, deps, retryOptions, turnAccumulator, callbacks } = options;
  const { logger, settingsService, sessionContextService } = deps;
  const { breakChaining, buildAndResolve, restartTurn, isCurrentGeneration } = callbacks;

  const conversationStore = new ConversationStore();
  const approvalState = new ApprovalState();
  const toolTracker = new SessionToolTracker(conversationStore);

  const retryOrchestrator = new SessionRetryOrchestrator(
    logger,
    id,
    agentClient,
    retryOptions?.allowFreshStartRetries ?? true,
  );

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient,
    logger,
    settingsService,
    sessionContextService,
  });

  const inputPlanner = new SessionInputPlanner({
    settingsService,
    agentClient,
    toolTracker,
    retryOrchestrator,
  });

  const state = new SessionStateController({
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
  });

  const conversationLogger = new ConversationLogger({
    turnAccumulator,
    logger,
    getAssistantTurnState: () => {
      const fn = getMethod<[], string>(agentClient, 'getProvider');
      const provider = fn ? fn.call(agentClient) : settingsService?.get<string>('agent.provider');
      const model = settingsService?.get<string>('agent.model');
      return {
        previousResponseId: state.previousResponseId,
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
    state,
    inputPlanner,
  });

  const continuationRunner = new ApprovalContinuationRunner({
    agentClient,
    approvalFlow,
    toolTracker,
    conversationStore,
    conversationLogger,
    retryOrchestrator,
    inputPlanner,
    state,
    logger,
    sessionId: id,
    streamProcessor,
    buildAndResolve,
    restartTurn,
  });

  const turnRunner = new ConversationTurnRunner({
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
    breakChaining,
    buildAndResolve,
    isCurrentGeneration,
  });

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
    continuationRunner,
    turnRunner,
  };
}
