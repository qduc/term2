import { type RunState, type AgentInputItem } from '@openai/agents';
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
import { toTerminalEvent, buildConversationResult } from './conversation-result-builder.js';
import { type SavedToolExecution, reconcileHistoryWithToolLedger } from './tool-execution-ledger.js';
import { describeError } from '../utils/error-helpers.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';
import { ChainingTransportDowngradeError } from '../providers/fallback-responses-model.js';
import type { AgentStream } from './agent-stream.js';
import { type PendingApprovalContext, type AbortedApprovalContext } from './approval-state.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import type { ProviderContinuity } from './provider-continuity.js';
import { ContinuationDriver, ShellAutoApprovalDecisionPolicy } from './continuation-driver.js';
import { DefaultConversationRecoveryPolicy } from './recovery-policy.js';
import { DefaultRecoveryExecutor } from './recovery-executor.js';
import type { RecoveryState, RetryCounts } from './retry-contracts.js';
import { GenerationGuard, type GenerationToken } from './generation-guard.js';
import { DefaultRetryClassifier } from './retry-classifier.js';
import { RetryEventPresenter } from './retry-event-presenter.js';

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
    this.deps.appState.statusMachine.beginTurn();
    try {
      yield* this.#executeRun(input, { ...options, token, abortedContext });
    } finally {
      this.deps.appState.statusMachine.complete();
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
        yield* this.#executeRun(dummyTurn, {
          skipUserMessage: true,
          retries: driveResult.retries,
          token: gen,
        });
      } else {
        yield toTerminalEvent(driveResult.result);
      }
    } finally {
      this.deps.appState.statusMachine.complete();
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

  // ── Private Execution Loops ────────────────────────────────────────

  async *#executeRun(
    input: string | UserTurn,
    {
      skipUserMessage = false,
      retries = {},
      maxModelRetries,
      signal,
      resumeState,
      resumePreviousResponseId,
      token,
      abortedContext,
    }: {
      skipUserMessage?: boolean;
      retries?: RetryState;
      maxModelRetries?: number;
      signal?: AbortSignal;
      resumeState?: RunState<any, any>;
      resumePreviousResponseId?: string | null;
      token?: GenerationToken;
      abortedContext?: AbortedApprovalContext | null;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    const {
      transientRetryCount = 0,
      flexServiceTierFallbackCount = 0,
      hallucinationRetryCount = 0,
      transportFallbackRetryCount = 0,
    } = retries;

    if (
      !skipUserMessage ||
      hallucinationRetryCount > 0 ||
      flexServiceTierFallbackCount > 0 ||
      transientRetryCount > 0 ||
      transportFallbackRetryCount > 0
    ) {
      this.deps.turnAccumulator.resetPersistedTurnState();
    }

    const finalAbortedContext = abortedContext !== undefined ? abortedContext : this.deps.approvalFlow.consumeAborted();
    if (finalAbortedContext) {
      const tokenVal = finalAbortedContext.token ?? 0;
      if (!this.deps.generationGuard.isCurrent(tokenVal)) {
        return;
      }
    }
    const gen = finalAbortedContext ? finalAbortedContext.token ?? 0 : token ?? this.deps.generationGuard.capture();
    let stream: AgentStream | null = null;
    let streamInput: string | AgentInputItem | AgentInputItem[] = '';
    let inputSurgeKind: 'delta' | 'full_history' = 'delta';
    const normalized = normalizeUserTurn(input);
    const turn: UserTurn = this.deps.state.pendingModeNotice?.trim()
      ? { ...normalized, text: `${this.deps.state.pendingModeNotice}\n\n${normalized.text}` }
      : normalized;
    const text = turn.text;
    let addedUserMessage = false;
    const ledgerSnapshot = this.deps.toolTracker.export();
    const maxTransientRetries = getMaxTransientRetries({
      streamMaxRetries: getMethod<[], number | undefined>(this.deps.agentClient, 'getStreamMaxRetries')?.call(
        this.deps.agentClient,
      ),
    });

    this.deps.toolTracker.ledger.beginTurn();
    let abortListener: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        this.deps.agentClient.abort();
        throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
      }
      abortListener = () => {
        this.deps.agentClient.abort();
      };
      signal.addEventListener('abort', abortListener);
    }

    try {
      this.deps.logger.debug('Conversation stream start', {
        eventType: 'stream.started',
        category: 'stream',
        phase: 'request_start',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
      });

      const shouldAddUserMessage = !skipUserMessage && !finalAbortedContext;

      if (shouldAddUserMessage) {
        this.deps.conversationStore.addUserTurn(turn);
        addedUserMessage = true;
      } else if (finalAbortedContext && !skipUserMessage) {
        yield { type: 'user_message_consumed_for_abort' };
      }

      if (finalAbortedContext) {
        this.deps.logger.debug('Resolving aborted approval with fake execution', {
          message: text,
        });

        const driveResult = yield* this.deps.continuationDriver.drive(
          { kind: 'abort_resolution', abortedContext: finalAbortedContext, userText: text, generation: gen },
          new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
        );

        if (driveResult.kind === 'approval_required') {
          this.deps.appState.statusMachine.requestApproval();
        }
        if (driveResult.kind !== 'fresh_start_required') {
          yield toTerminalEvent(driveResult.result);
        }

        return;
      }

      const plan = this.deps.inputPlanner.build(turn, {
        includeTurn: false,
        pendingModeNotice: this.deps.state.pendingModeNotice,
      });
      streamInput = plan.streamInput;
      inputSurgeKind = plan.inputSurgeKind;
      this.deps.state.setInputSurgeKind(inputSurgeKind);

      const surgeDecision = this.deps.inputPlanner.inspectForSurge(streamInput, inputSurgeKind);
      if (surgeDecision.action === 'block') {
        let droppedUserMessage: { text: string; imageCount: number } | undefined;
        if (addedUserMessage && this.deps.retryOrchestrator.isCurrentGeneration(gen)) {
          this.deps.conversationStore.removeLastUserMessage();
          droppedUserMessage = { text: turn.text, imageCount: turn.images?.length ?? 0 };
        }

        this.deps.logger.warn('Input surge guard blocked provider request', {
          eventType: 'input_surge.blocked',
          category: 'provider',
          phase: 'request_start',
          sessionId: this.deps.sessionId,
          traceId: this.deps.logger.getCorrelationId(),
          reason: surgeDecision.reason,
          stats: surgeDecision.stats,
          previousStats: surgeDecision.previousStats,
        });

        yield {
          type: 'error',
          kind: 'input_surge_guard',
          message: `${surgeDecision.reason} Request blocked to prevent runaway context growth. Try /undo or /clear, or compact the conversation history.`,
          ...(droppedUserMessage ? { droppedUserMessage } : {}),
        };
        return;
      }

      if (this.deps.state.pendingModeNotice) {
        this.deps.state.pendingModeNotice = null;
      }

      try {
        if (resumeState && typeof this.deps.agentClient.continueRunStream === 'function') {
          stream = (await this.deps.agentClient.continueRunStream(resumeState, {
            previousResponseId: resumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
            sessionId: this.deps.sessionId,
          })) as AgentStream;
        } else {
          stream = (await this.deps.agentClient.startStream(streamInput, {
            previousResponseId: inputSurgeKind === 'delta' ? this.deps.providerContinuity.previousResponseId : null,
            sessionId: this.deps.sessionId,
          })) as AgentStream;
        }
      } catch (chainingError) {
        if (
          chainingError instanceof ChainingTransportDowngradeError &&
          this.deps.retryOrchestrator.freshStartRetriesAllowed
        ) {
          this.deps.breakChaining();

          this.deps.logger.warn('ChainingTransportDowngradeError caught, retrying with full history', {
            eventType: 'retry.chaining_downgrade',
            category: 'retry',
            phase: 'retry',
            retryType: 'chaining_downgrade',
            sessionId: this.deps.sessionId,
            traceId: this.deps.logger.getCorrelationId(),
            errorMessage: chainingError instanceof Error ? chainingError.message : String(chainingError),
          });

          const fullHistoryRetryPlan = this.deps.inputPlanner.build(turn, {
            includeTurn: false,
            pendingModeNotice: this.deps.state.pendingModeNotice,
          });
          inputSurgeKind = fullHistoryRetryPlan.inputSurgeKind;
          this.deps.state.setInputSurgeKind(inputSurgeKind);
          stream = (await this.deps.agentClient.startStream(fullHistoryRetryPlan.streamInput, {
            previousResponseId: null,
            sessionId: this.deps.sessionId,
          })) as AgentStream;
        } else {
          throw chainingError;
        }
      }

      const acc = yield* this.deps.streamProcessor.process(stream, {
        gen,
        source: 'startStream',
        preserveExistingToolArgs: false,
      });

      this.deps.streamProcessor.finalize(stream, gen, this.deps.retryOrchestrator.inputSurgeKindState, 'startStream');

      const outcome = await buildConversationResult(
        {
          result: stream,
          finalOutputOverride: acc.finalOutput || undefined,
          reasoningOutputOverride: acc.reasoningOutput || undefined,
          emittedCommandIds: acc.emittedCommandIds,
          usage: acc.latestUsage,
          toolCallArgumentsById: this.deps.toolTracker.argumentsById,
          turnItems: this.deps.turnAccumulator.getTurnItems(),
          token: gen,
        },
        {
          approvalFlow: this.deps.approvalFlow,
          shellAutoApproval: this.deps.shellAutoApproval,
          logger: this.deps.logger,
          sessionId: this.deps.sessionId,
        },
      );

      if (outcome.kind === 'response') {
        this.deps.inputPlanner.recordSuccess(
          inputSurgeKind === 'delta' ? streamInput : this.deps.conversationStore.getHistory(),
          inputSurgeKind === 'delta' ? { kind: inputSurgeKind } : { kind: inputSurgeKind, previousInput: streamInput },
        );
        yield toTerminalEvent(outcome.result);
        return;
      }

      this.deps.inputPlanner.recordSuccess(
        inputSurgeKind === 'delta' ? streamInput : this.deps.conversationStore.getHistory(),
        inputSurgeKind === 'delta' ? { kind: inputSurgeKind } : { kind: inputSurgeKind, previousInput: streamInput },
      );

      if (outcome.kind === 'auto_approve') {
        this.deps.logger.debug('Shell command auto-approved by LLM', {
          eventType: 'approval.auto_approved',
          category: 'approval',
          phase: 'approval',
          sessionId: this.deps.sessionId,
          traceId: this.deps.logger.getCorrelationId(),
          callId: outcome.callId,
          command: outcome.argumentsText,
          model: outcome.advisory.model,
          reasoning: outcome.advisory.reasoning,
        });

        const driveResult = yield* this.deps.continuationDriver.drive(
          { kind: 'approval_decision', answer: 'y', generation: gen },
          new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
        );

        if (driveResult.kind === 'approval_required') {
          this.deps.appState.statusMachine.requestApproval();
        }
        if (driveResult.kind !== 'fresh_start_required') {
          yield toTerminalEvent(driveResult.result);
        }
        return;
      }

      if (outcome.result.approval.callId) {
        this.deps.toolTracker.recordFunctionCall({
          type: 'function_call',
          callId: outcome.result.approval.callId,
          name: outcome.result.approval.toolName,
          arguments: outcome.result.approval.argumentsText,
        });
      }
      this.deps.logger.debug('Tool approval required', {
        eventType: 'approval.required',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        toolName: outcome.result.approval.toolName,
      });
      this.deps.appState.statusMachine.requestApproval();
      yield toTerminalEvent(outcome.result);
    } catch (error) {
      const handled = yield* this.#handleRetryDecision({
        error,
        turn,
        gen,
        stream,
        streamInput,
        addedUserMessage,
        ledgerSnapshot,
        retries: {
          transientRetryCount,
          flexServiceTierFallbackCount,
          hallucinationRetryCount,
          transportFallbackRetryCount,
        },
        maxTransientRetries,
        maxModelRetries,
      });
      if (handled) return;

      throw error;
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  async *#handleRetryDecision(ctx: {
    error: unknown;
    turn: UserTurn;
    gen: number;
    stream: AgentStream | null;
    streamInput: string | AgentInputItem | AgentInputItem[];
    addedUserMessage: boolean;
    ledgerSnapshot: SavedToolExecution[];
    retries: RetryState;
    maxTransientRetries: number;
    maxModelRetries?: number;
  }): AsyncGenerator<ConversationEvent, boolean> {
    const {
      error,
      turn,
      gen,
      stream,
      streamInput,
      addedUserMessage,
      ledgerSnapshot,
      retries,
      maxTransientRetries,
      maxModelRetries,
    } = ctx;

    const {
      transientRetryCount = 0,
      flexServiceTierFallbackCount = 0,
      hallucinationRetryCount = 0,
      transportFallbackRetryCount = 0,
    } = retries;

    const retryCounts: RetryCounts = {
      transientRetryCount,
      serviceTierFallbackCount: flexServiceTierFallbackCount,
      modelRetryCount: hallucinationRetryCount,
      transportDowngradeCount: transportFallbackRetryCount,
    };

    let classified = this.deps.retryClassifier.classify({
      error,
      retryCounts,
      stream,
      maxTransientRetries,
      maxModelRetries,
    });

    if (!this.deps.retryOrchestrator.freshStartRetriesAllowed && !stream && classified.kind !== 'unrecoverable') {
      this.deps.logger.warn('Retry requires fresh start but fresh-start retries are disabled for this session', {
        eventType: 'retry.fresh_start_blocked',
        category: 'retry',
        phase: 'retry',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        retryKind: classified.kind,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      classified = { kind: 'unrecoverable' };
    }

    if (classified.kind === 'unrecoverable') {
      let droppedUserMessage: { text: string; imageCount: number } | undefined;
      if (addedUserMessage && !stream && this.deps.retryOrchestrator.isCurrentGeneration(gen)) {
        this.deps.conversationStore.removeLastUserMessage();
        droppedUserMessage = { text: turn.text, imageCount: turn.images?.length ?? 0 };
      }
      if (stream && this.deps.retryOrchestrator.isCurrentGeneration(gen)) {
        this.deps.toolTracker.markOpenCallsAborted(error instanceof Error ? error.message : String(error));
        const reconciled = reconcileHistoryWithToolLedger(
          this.deps.conversationStore.getHistory(),
          this.deps.toolTracker.export(),
        );
        if (reconciled.addedCompletedPairs > 0 || reconciled.droppedIncompleteCalls > 0) {
          this.deps.conversationStore.replaceHistory(reconciled.history as AgentInputItem[]);
        }
      }
      this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
        kind: 'full_history',
        previousInput: streamInput,
      });
      const recoverySummary = this.deps.toolTracker.getRecoverySummary();
      if (recoverySummary) {
        yield {
          type: 'tool_recovery',
          recoveredCallIds: recoverySummary.recoveredCallIds,
          droppedCallIds: recoverySummary.droppedCallIds,
          message: recoverySummary.message,
        };
      }
      yield {
        type: 'error',
        message: describeError(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        ...(droppedUserMessage ? { droppedUserMessage } : {}),
      };
      this.deps.logger.error('Conversation stream error', {
        eventType: 'stream.failed',
        category: 'stream',
        phase: 'abort',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        errorMessage: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    }

    const presentation = this.deps.retryEventPresenter.present({
      failure: classified,
      maxTransientRetries,
      maxModelRetries,
      source: 'initial',
      error,
    });

    yield presentation.event;

    this.deps.logger.warn(presentation.logMessage, {
      ...presentation.logFields,
      sessionId: this.deps.sessionId,
      traceId: this.deps.logger.getCorrelationId(),
    });

    if (!this.deps.retryOrchestrator.isCurrentGeneration(gen)) {
      return true;
    }

    if (classified.kind === 'transient') {
      await new Promise((resolve) => setTimeout(resolve, classified.delayMs));

      if (!this.deps.retryOrchestrator.isCurrentGeneration(gen)) {
        return true;
      }
    }

    const nextRetryCounts = this.deps.recoveryPolicy.nextRetryCounts(retryCounts, classified);

    const plan = this.deps.recoveryPolicy.plan({
      failure: classified,
      gen,
      stream,
      retryCounts,
      maxModelRetries,
      freshStartRetriesAllowed: this.deps.retryOrchestrator.freshStartRetriesAllowed,
    });

    const recoveryState: RecoveryState = {
      ledgerSnapshot,
      addedUserMessage,
      stream,
    };

    const result = this.deps.recoveryExecutor.apply({
      plan,
      state: recoveryState,
      retryCounts: nextRetryCounts,
      maxModelRetries,
    });

    if (result.kind === 'terminated') {
      for (const event of result.events) {
        yield event;
      }
      yield {
        type: 'error',
        message: describeError(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      };
      this.deps.logger.error('Conversation stream error', {
        eventType: 'stream.failed',
        category: 'stream',
        phase: 'abort',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        errorMessage: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    }

    if (result.useStandardServiceTier) {
      getMethod<[], void>(this.deps.agentClient, 'useStandardServiceTierForNextRequest')?.call(this.deps.agentClient);
    }

    yield* this.#executeRun(turn, {
      skipUserMessage: result.instruction.skipUserMessage,
      retries: this.#retryCountsToState(result.instruction.retryCounts),
      maxModelRetries: result.instruction.maxModelRetries,
      resumeState: result.instruction.resumeState,
      resumePreviousResponseId: result.instruction.resumePreviousResponseId,
      token: gen,
    });
    return true;
  }

  #retryCountsToState(counts: RetryCounts): RetryState {
    return {
      transientRetryCount: counts.transientRetryCount,
      flexServiceTierFallbackCount: counts.serviceTierFallbackCount,
      hallucinationRetryCount: counts.modelRetryCount,
      transportFallbackRetryCount: counts.transportDowngradeCount,
    };
  }
}
