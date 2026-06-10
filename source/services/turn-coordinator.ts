import { type RunState } from '@openai/agents';
import type { ILoggingService } from './service-interfaces.js';
import { type RetryState, SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import type { ConversationEvent } from './conversation-events.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationStore } from './conversation-store.js';
import { ConversationLogger } from './conversation-logger.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { ConversationAgentClient } from './conversation-agent-client.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { getCallIdFromObject, getMethod } from './interruption-info.js';
import { getMaxTransientRetries } from './conversation-retry-policy.js';
import { toTerminalEvent } from './conversation-result-builder.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';
import { type PendingApprovalContext } from './approval-state.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import type { ProviderContinuity } from './provider-continuity.js';
import { ContinuationDriver, ShellAutoApprovalDecisionPolicy } from './continuation-driver.js';
import { DefaultConversationRecoveryPolicy } from './recovery-policy.js';
import { DefaultRecoveryExecutor } from './recovery-executor.js';
import { GenerationGuard, type GenerationToken } from './generation-guard.js';
import { DefaultRetryClassifier } from './retry-classifier.js';
import { RetryEventPresenter } from './retry-event-presenter.js';
import { InitialTurnRunner, type InitialTurnOutcome } from './initial-turn-runner.js';
import { TurnAttempt } from './turn-attempt.js';
import type { RetryCounts } from './retry-contracts.js';

export type SessionStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'continuing';

export class TurnState {
  statusMachine = new TurnStatusMachine();
  currentGeneration = 0;
  pendingModeNotice: string | null = null;
  previousResponseId: string | null = null;
  transportDowngradeOccurred = false;
  pendingApproval: PendingApprovalContext | null = null;
}

export interface TurnCoordinatorDeps {
  agentClient: ConversationAgentClient;
  logger: ILoggingService;
  sessionId: string;
  turnAccumulator: TurnItemAccumulator;
  retryOrchestrator: SessionRetryOrchestrator;
  toolTracker: SessionToolTracker;
  conversationStore: ConversationStore;
  conversationLogger: ConversationLogger;
  approvalFlow: ApprovalFlowCoordinator;
  shellAutoApproval: ShellAutoApprovalResolver;
  inputPlanner: SessionInputPlanner;
  state: SessionLifecycle;
  streamProcessor: SessionStreamProcessor;
  appState: TurnState;
  providerContinuity: ProviderContinuity;
  breakChaining: () => void;
  continuationDriver: ContinuationDriver;
  recoveryPolicy: DefaultConversationRecoveryPolicy;
  recoveryExecutor: DefaultRecoveryExecutor;
  generationGuard: GenerationGuard;
  retryClassifier: DefaultRetryClassifier;
  retryEventPresenter: RetryEventPresenter;
  initialTurnRunner: InitialTurnRunner;
}

export class TurnCoordinator {
  constructor(private readonly deps: TurnCoordinatorDeps) {}

  async *start(
    input: string | UserTurn,
    options: {
      skipUserMessage?: boolean;
      retries?: RetryState;
      maxModelRetries?: number;
      signal?: AbortSignal;
      resumeState?: RunState<any, any>;
      resumePreviousResponseId?: string | null;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    if (!this.deps.appState.statusMachine.is('idle')) {
      throw new Error('Another foreground turn is already active.');
    }
    const abortedContext = this.deps.approvalFlow.consumeAborted();
    let token: GenerationToken;
    if (abortedContext) {
      const tokenVal = abortedContext.token ?? 0;
      if (this.deps.generationGuard.isCurrent(tokenVal)) {
        token = tokenVal;
      } else {
        return;
      }
    } else {
      token = this.deps.generationGuard.capture();
    }

    const normalized = normalizeUserTurn(input);
    const turn: UserTurn = this.deps.state.pendingModeNotice?.trim()
      ? { ...normalized, text: `${this.deps.state.pendingModeNotice}\n\n${normalized.text}` }
      : normalized;

    const maxTransientRetries = getMaxTransientRetries({
      streamMaxRetries: getMethod<[], number | undefined>(this.deps.agentClient, 'getStreamMaxRetries')?.call(
        this.deps.agentClient,
      ),
    });

    const attempt = new TurnAttempt({
      turn,
      token,
      initialRetryCounts: this.#retryStateToCounts(options.retries ?? {}),
      initialLedgerSnapshot: this.deps.toolTracker.export(),
      maxTransientRetries,
      maxModelRetries: options.maxModelRetries,
      signal: options.signal,
      onAbort: () => {
        this.deps.agentClient.abort();
      },
    });

    this.deps.appState.statusMachine.beginTurn();
    let runnerOutcome: InitialTurnOutcome | undefined;
    try {
      const it = this.deps.initialTurnRunner.run(attempt, {
        skipUserMessage: options.skipUserMessage,
        resumeState: options.resumeState,
        resumePreviousResponseId: options.resumePreviousResponseId,
        abortedContext,
      });

      let res = await it.next();
      while (!res.done) {
        yield res.value;
        res = await it.next();
      }
      runnerOutcome = res.value;
      if (
        runnerOutcome &&
        (runnerOutcome.kind === 'response' ||
          runnerOutcome.kind === 'approval_required' ||
          runnerOutcome.kind === 'stale')
      ) {
        if (runnerOutcome.terminal) {
          yield toTerminalEvent(runnerOutcome.terminal);
        }
      }
    } finally {
      if (runnerOutcome && runnerOutcome.kind === 'stale') {
        // stale
      } else if (runnerOutcome && runnerOutcome.kind === 'approval_required') {
        this.deps.appState.statusMachine.requestApproval();
      } else {
        this.deps.appState.statusMachine.complete();
      }
    }
  }

  async *continueAfterApproval({
    answer,
    rejectionReason,
  }: {
    answer: string;
    rejectionReason?: string;
  }): AsyncIterable<ConversationEvent> {
    if (!this.deps.appState.statusMachine.is('awaiting_approval')) {
      throw new Error('No pending approval to continue.');
    }
    this.deps.appState.statusMachine.beginContinuation();
    let runnerCalled = false;
    let runnerOutcome: InitialTurnOutcome | undefined;
    try {
      const pending = this.deps.approvalFlow.getPending();
      const gen = pending?.token ?? this.deps.retryOrchestrator.currentGeneration;
      const policy = new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval);

      const driveResult = yield* this.deps.continuationDriver.drive(
        { kind: 'approval_decision', answer, rejectionReason, generation: gen },
        policy,
      );

      if (driveResult.kind === 'approval_required') {
        this.deps.appState.statusMachine.requestApproval();
        yield toTerminalEvent(driveResult.result);
      } else if (driveResult.kind === 'fresh_start_required') {
        const lastUserText = this.deps.conversationStore.getLastUserMessage();
        const dummyTurn: UserTurn = { text: lastUserText };

        this.deps.appState.statusMachine.complete();

        const maxTransientRetries = getMaxTransientRetries({
          streamMaxRetries: getMethod<[], number | undefined>(this.deps.agentClient, 'getStreamMaxRetries')?.call(
            this.deps.agentClient,
          ),
        });

        const attempt = new TurnAttempt({
          turn: dummyTurn,
          token: gen,
          initialRetryCounts: driveResult.retryCounts,
          initialLedgerSnapshot: this.deps.toolTracker.export(),
          maxTransientRetries,
          signal: undefined,
        });

        runnerCalled = true;
        this.deps.appState.statusMachine.beginTurn();
        const it = this.deps.initialTurnRunner.run(attempt, {
          skipUserMessage: true,
        });
        let res = await it.next();
        while (!res.done) {
          yield res.value;
          res = await it.next();
        }
        runnerOutcome = res.value;
        if (
          runnerOutcome &&
          (runnerOutcome.kind === 'response' ||
            runnerOutcome.kind === 'approval_required' ||
            runnerOutcome.kind === 'stale')
        ) {
          if (runnerOutcome.terminal) {
            yield toTerminalEvent(runnerOutcome.terminal);
          }
        }
      } else if (driveResult.kind === 'stale') {
        // stale - do nothing
      } else {
        yield toTerminalEvent(driveResult.result);
      }
    } finally {
      if (runnerCalled) {
        if (runnerOutcome && runnerOutcome.kind === 'approval_required') {
          this.deps.appState.statusMachine.requestApproval();
        } else if (runnerOutcome && runnerOutcome.kind === 'stale') {
          // stale
        } else {
          this.deps.appState.statusMachine.complete();
        }
      } else {
        this.deps.appState.statusMachine.complete();
      }
    }
  }

  abort(): void {
    const pending = this.deps.approvalFlow.getPending();
    const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
    if (this.deps.approvalFlow.abort()) {
      this.deps.toolTracker.recordAbortedApproval(
        'Tool execution was not approved.',
        'Tool execution was not approved.',
        callId,
      );
    }
    this.deps.appState.statusMachine.abort();
  }

  #retryStateToCounts(state: RetryState): RetryCounts {
    return {
      transientRetryCount: state.transientRetryCount ?? 0,
      serviceTierFallbackCount: state.flexServiceTierFallbackCount ?? 0,
      modelRetryCount: state.hallucinationRetryCount ?? 0,
      transportDowngradeCount: state.transportFallbackRetryCount ?? 0,
    };
  }
}
