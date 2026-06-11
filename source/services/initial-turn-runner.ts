import { type RunState } from '@openai/agents';
import type { ConversationEvent } from './conversation-events.js';
import type { ConversationTerminal } from '../contracts/conversation.js';
import type { ILoggingService } from './service-interfaces.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ConversationStore } from './conversation-store.js';
import type { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import type { AbortedApprovalContext } from './approval-state.js';
import type { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { SessionLifecycle } from './session-lifecycle.js';
import type { SessionStreamProcessor } from './session-stream-processor.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import type { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ProviderContinuity } from './provider-continuity.js';
import type { ContinuationDriver } from './continuation-driver.js';
import type { DefaultConversationRecoveryPolicy } from './recovery-policy.js';
import type { DefaultRecoveryExecutor } from './recovery-executor.js';
import type { GenerationGuard } from './generation-guard.js';
import type { DefaultRetryClassifier } from './retry-classifier.js';
import type { RetryEventPresenter } from './retry-event-presenter.js';
import { TurnAttempt } from './turn-attempt.js';
import type { RecoveryState, NextRunInstruction, RetryCounts } from './retry-contracts.js';
import type { AgentStream } from './agent-stream.js';
import { getMethod } from './interruption-info.js';
import { buildConversationResult } from './conversation-result-builder.js';
import { describeError } from '../utils/error-helpers.js';
import { ShellAutoApprovalDecisionPolicy } from './continuation-driver.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';

export type InitialTurnOutcome =
  | { kind: 'response'; terminal: ConversationTerminal }
  | { kind: 'approval_required'; terminal: ConversationTerminal }
  | { kind: 'failed' }
  | { kind: 'stale' };

export interface InitialTurnRunnerDeps {
  agentClient: ConversationAgentClient;
  logger: ILoggingService;
  sessionId: string;
  turnAccumulator: TurnItemAccumulator;
  toolTracker: SessionToolTracker;
  conversationStore: ConversationStore;
  approvalFlow: ApprovalFlowCoordinator;
  shellAutoApproval: ShellAutoApprovalResolver;
  inputPlanner: SessionInputPlanner;
  state: SessionLifecycle;
  streamProcessor: SessionStreamProcessor;
  providerContinuity: ProviderContinuity;
  breakChaining: () => void;
  continuationDriver: ContinuationDriver;
  recoveryPolicy: DefaultConversationRecoveryPolicy;
  recoveryExecutor: DefaultRecoveryExecutor;
  generationGuard: GenerationGuard;
  retryClassifier: DefaultRetryClassifier;
  retryEventPresenter: RetryEventPresenter;
  freshStartRetriesAllowed: boolean;
}

export class InitialTurnRunner {
  constructor(private readonly deps: InitialTurnRunnerDeps) {}

  async *run(
    attemptOrInput: TurnAttempt | string | UserTurn,
    options: {
      skipUserMessage?: boolean;
      resumeState?: RunState<any, any>;
      resumePreviousResponseId?: string | null;
      abortedContext?: AbortedApprovalContext | null;
      token?: number;
      retries?: any;
      maxModelRetries?: number;
      signal?: AbortSignal;
      delayMs?: number;
      useStandardServiceTier?: boolean;
    } = {},
  ): AsyncGenerator<ConversationEvent, InitialTurnOutcome, void> {
    let attempt: TurnAttempt;
    if (attemptOrInput instanceof TurnAttempt) {
      attempt = attemptOrInput;
    } else {
      const normalized = normalizeUserTurn(attemptOrInput);
      let turn: UserTurn = this.deps.state.pendingModeNotice?.trim()
        ? { ...normalized, text: `${this.deps.state.pendingModeNotice}\n\n${normalized.text}` }
        : normalized;

      if (!turn.text && options.skipUserMessage) {
        try {
          const lastText = this.deps.conversationStore.getLastUserMessage();
          turn = { ...turn, text: lastText };
        } catch {
          // ignore
        }
      }

      const maxTransientRetries = 0;

      let token: number;
      if (options.abortedContext) {
        const tokenVal = options.abortedContext.token ?? 0;
        if (this.deps.generationGuard.isCurrent(tokenVal)) {
          token = tokenVal;
        } else {
          return { kind: 'stale' };
        }
      } else {
        token = options.token ?? this.deps.generationGuard.capture();
      }

      const rawRetries = options.retries ?? {};
      const retryCounts: RetryCounts = {
        transientRetryCount: rawRetries.transientRetryCount ?? rawRetries.transientRetryCount ?? 0,
        serviceTierFallbackCount: rawRetries.serviceTierFallbackCount ?? rawRetries.flexServiceTierFallbackCount ?? 0,
        modelRetryCount: rawRetries.modelRetryCount ?? rawRetries.hallucinationRetryCount ?? 0,
        transportDowngradeCount: rawRetries.transportDowngradeCount ?? rawRetries.transportFallbackRetryCount ?? 0,
      };

      attempt = new TurnAttempt({
        turn,
        token,
        initialRetryCounts: retryCounts,
        initialLedgerSnapshot: this.deps.toolTracker.export(),
        maxTransientRetries,
        maxModelRetries: options.maxModelRetries,
        signal: options.signal,
        onAbort: () => {
          this.deps.agentClient.abort();
        },
      });
    }

    let skipUser = options.skipUserMessage ?? false;
    let currentResumeState = options.resumeState;
    let currentResumePreviousResponseId = options.resumePreviousResponseId;
    let currentAbortedContext = options.abortedContext ?? null;

    const initialCounts = attempt.retryCounts;
    if (
      !skipUser ||
      initialCounts.modelRetryCount > 0 ||
      initialCounts.serviceTierFallbackCount > 0 ||
      initialCounts.transientRetryCount > 0 ||
      initialCounts.transportDowngradeCount > 0
    ) {
      this.deps.turnAccumulator.resetPersistedTurnState();
    }

    try {
      if (options.delayMs && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (!this.deps.generationGuard.isCurrent(attempt.token)) {
        return { kind: 'stale' };
      }
      if (options.useStandardServiceTier) {
        getMethod<[], void>(this.deps.agentClient, 'useStandardServiceTierForNextRequest')?.call(this.deps.agentClient);
      }

      this.deps.toolTracker.ledger.beginTurn();

      while (true) {
        // 1. Check generation token validity
        if (currentAbortedContext) {
          const tokenVal = currentAbortedContext.token ?? 0;
          if (!this.deps.generationGuard.isCurrent(tokenVal)) {
            return { kind: 'stale' };
          }
        } else {
          if (!this.deps.generationGuard.isCurrent(attempt.token)) {
            return { kind: 'stale' };
          }
        }

        // 2. Handle aborted-approval resolution
        if (currentAbortedContext) {
          if (!skipUser) {
            yield { type: 'user_message_consumed_for_abort' };
          }
          this.deps.logger.debug('Resolving aborted approval with fake execution', {
            message: attempt.turn.text,
          });

          const driveResult = yield* this.deps.continuationDriver.drive(
            {
              kind: 'abort_resolution',
              abortedContext: currentAbortedContext,
              userText: attempt.turn.text,
              generation: attempt.token,
            },
            new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
          );

          if (driveResult.kind === 'approval_required') {
            return { kind: 'approval_required', terminal: driveResult.result };
          }
          if (driveResult.kind === 'stale') {
            return { kind: 'stale' };
          }
          if (driveResult.kind === 'response') {
            return { kind: 'response', terminal: driveResult.result };
          }

          // If fresh_start_required, we move to a fresh run in the loop
          currentAbortedContext = null;
          skipUser = true;
          currentResumeState = undefined;
          currentResumePreviousResponseId = undefined;
          continue;
        }

        // 3. User message insertion
        const shouldAddUserMessage = !skipUser;
        if (shouldAddUserMessage && !attempt.addedUserMessage) {
          this.deps.conversationStore.addUserTurn(attempt.turn);
          attempt.markUserMessageAdded();
        }

        // 4. Build input plan and run surge check
        const plan = this.deps.inputPlanner.build(attempt.turn, {
          includeTurn: false,
          pendingModeNotice: this.deps.state.pendingModeNotice,
        });
        attempt.attachInput(plan);
        const surgeDecision = this.deps.inputPlanner.inspectForSurge(attempt.streamInput, attempt.inputMode!);
        if (surgeDecision.action === 'block') {
          let droppedUserMessage: { text: string; imageCount: number } | undefined;
          if (attempt.addedUserMessage && this.deps.generationGuard.isCurrent(attempt.token)) {
            this.deps.conversationStore.removeLastUserMessage();
            droppedUserMessage = { text: attempt.turn.text, imageCount: attempt.turn.images?.length ?? 0 };
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
          return { kind: 'failed' };
        }

        if (this.deps.state.pendingModeNotice) {
          this.deps.state.pendingModeNotice = null;
        }

        let stream: AgentStream | null = null;
        let acc;
        try {
          if (currentResumeState && typeof this.deps.agentClient.continueRunStream === 'function') {
            stream = (await this.deps.agentClient.continueRunStream(currentResumeState, {
              previousResponseId: currentResumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
              sessionId: this.deps.sessionId,
            })) as AgentStream;
          } else {
            stream = (await this.deps.agentClient.startStream(attempt.streamInput!, {
              previousResponseId:
                attempt.inputMode === 'delta' ? this.deps.providerContinuity.previousResponseId : null,
              sessionId: this.deps.sessionId,
            })) as AgentStream;
          }

          attempt.attachStream(stream);

          acc = yield* this.deps.streamProcessor.process(stream, {
            gen: attempt.token,
            source: 'startStream',
            preserveExistingToolArgs: false,
          });

          const finalizeResult = this.deps.streamProcessor.finalize(
            stream,
            attempt.token,
            attempt.inputMode!,
            'startStream',
          );
          if (finalizeResult.kind === 'stale') {
            return { kind: 'stale' };
          }

          // 6. Build outcome
          const outcome = await buildConversationResult(
            {
              result: stream,
              finalOutputOverride: acc.finalOutput || undefined,
              reasoningOutputOverride: acc.reasoningOutput || undefined,
              emittedCommandIds: acc.emittedCommandIds,
              usage: acc.latestUsage,
              toolCallArgumentsById: this.deps.toolTracker.argumentsById,
              turnItems: this.deps.turnAccumulator.getTurnItems(),
              token: attempt.token,
              inputMode: attempt.inputMode!,
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
              attempt.inputMode === 'delta' ? attempt.streamInput! : this.deps.conversationStore.getHistory(),
              attempt.inputMode === 'delta'
                ? { kind: attempt.inputMode }
                : { kind: attempt.inputMode!, previousInput: attempt.streamInput! },
            );
            return { kind: 'response', terminal: outcome.result };
          }

          this.deps.inputPlanner.recordSuccess(
            attempt.inputMode === 'delta' ? attempt.streamInput! : this.deps.conversationStore.getHistory(),
            attempt.inputMode === 'delta'
              ? { kind: attempt.inputMode }
              : { kind: attempt.inputMode!, previousInput: attempt.streamInput! },
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
              { kind: 'approval_decision', answer: 'y', generation: attempt.token },
              new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
            );

            if (driveResult.kind === 'approval_required') {
              return { kind: 'approval_required', terminal: driveResult.result };
            }
            if (driveResult.kind === 'stale') {
              return { kind: 'stale' };
            }
            if (driveResult.kind === 'response') {
              return { kind: 'response', terminal: driveResult.result };
            }

            // Auto-approved fresh start
            attempt.advanceRetry(driveResult.retryCounts);
            skipUser = true;
            currentResumeState = undefined;
            currentResumePreviousResponseId = undefined;
            currentAbortedContext = null;
            continue;
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
          return { kind: 'approval_required', terminal: outcome.result };
        } catch (error) {
          const handled = yield* this.#handleRetryDecision({
            error,
            attempt,
            stream,
          });

          if (handled.kind === 'run') {
            skipUser = handled.instruction.skipUserMessage;
            currentResumeState = handled.instruction.resumeState;
            currentResumePreviousResponseId = handled.instruction.resumePreviousResponseId;
            currentAbortedContext = null;
            if (handled.delayMs && handled.delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, handled.delayMs));
            }
            if (handled.useStandardServiceTier) {
              getMethod<[], void>(this.deps.agentClient, 'useStandardServiceTierForNextRequest')?.call(
                this.deps.agentClient,
              );
            }
            continue;
          } else if (handled.kind === 'stale') {
            return { kind: 'stale' };
          } else {
            throw error;
          }
        }
      }
    } finally {
      attempt.close();
    }
  }

  async *#handleRetryDecision(ctx: {
    error: unknown;
    attempt: TurnAttempt;
    stream: AgentStream | null;
  }): AsyncGenerator<
    ConversationEvent,
    | { kind: 'run'; instruction: NextRunInstruction; delayMs?: number; useStandardServiceTier?: boolean }
    | { kind: 'terminated' }
    | { kind: 'stale' },
    void
  > {
    const { error, attempt, stream } = ctx;

    if (!this.deps.generationGuard.isCurrent(attempt.token)) {
      return { kind: 'stale' };
    }

    let classified = this.deps.retryClassifier.classify({
      error,
      retryCounts: attempt.retryCounts,
      stream,
      maxTransientRetries: attempt.maxTransientRetries,
      maxModelRetries: attempt.maxModelRetries,
    });

    if (!this.deps.freshStartRetriesAllowed && !stream && classified.kind !== 'unrecoverable') {
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
      const droppedUserMessage =
        attempt.addedUserMessage && !stream
          ? { text: attempt.turn.text, imageCount: attempt.turn.images?.length ?? 0 }
          : undefined;
      const plan = this.deps.recoveryPolicy.plan({
        failure: classified,
        gen: attempt.token,
        stream,
        retryCounts: attempt.retryCounts,
        maxModelRetries: attempt.maxModelRetries,
        freshStartRetriesAllowed: this.deps.freshStartRetriesAllowed,
      });
      const recoveryResult = this.deps.recoveryExecutor.apply({
        plan,
        state: {
          ledgerSnapshot: attempt.initialLedgerSnapshot,
          addedUserMessage: attempt.addedUserMessage,
          stream,
        },
        retryCounts: attempt.retryCounts,
        maxModelRetries: attempt.maxModelRetries,
      });

      this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
        kind: 'full_history',
        previousInput: attempt.streamInput,
      });
      for (const event of recoveryResult.events) {
        yield event;
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
      return { kind: 'terminated' };
    }

    const presentation = this.deps.retryEventPresenter.present({
      failure: classified,
      maxTransientRetries: attempt.maxTransientRetries,
      maxModelRetries: attempt.maxModelRetries,
      source: 'initial',
      error,
    });

    yield presentation.event;

    this.deps.logger.warn(presentation.logMessage, {
      ...presentation.logFields,
      sessionId: this.deps.sessionId,
      traceId: this.deps.logger.getCorrelationId(),
    });

    if (!this.deps.generationGuard.isCurrent(attempt.token)) {
      return { kind: 'stale' };
    }

    const nextRetryCounts = this.deps.recoveryPolicy.nextRetryCounts(attempt.retryCounts, classified);
    attempt.advanceRetry(nextRetryCounts);

    const plan = this.deps.recoveryPolicy.plan({
      failure: classified,
      gen: attempt.token,
      stream,
      retryCounts: attempt.retryCounts,
      maxModelRetries: attempt.maxModelRetries,
      freshStartRetriesAllowed: this.deps.freshStartRetriesAllowed,
    });

    const recoveryState: RecoveryState = {
      ledgerSnapshot: attempt.initialLedgerSnapshot,
      addedUserMessage: attempt.addedUserMessage,
      stream,
    };

    const result = this.deps.recoveryExecutor.apply({
      plan,
      state: recoveryState,
      retryCounts: attempt.retryCounts,
      maxModelRetries: attempt.maxModelRetries,
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
      return { kind: 'terminated' };
    }

    return {
      kind: 'run',
      instruction: result.instruction,
      delayMs: classified.kind === 'transient' ? classified.delayMs : undefined,
      useStandardServiceTier: result.useStandardServiceTier,
    };
  }
}
