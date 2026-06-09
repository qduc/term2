import type { ConversationAgentClient } from './conversation-agent-client.js';
import type { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ConversationStore } from './conversation-store.js';
import type { ConversationLogger } from './conversation-logger.js';
import type { SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { ILoggingService } from './service-interfaces.js';
import type { ConversationEvent } from './conversation-events.js';
import type { AgentStream } from './agent-stream.js';
import type { ConversationTerminal } from '../contracts/conversation.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import { getCallIdFromObject, getMethod } from './interruption-info.js';
import { getMaxTransientRetries } from './conversation-retry-policy.js';
import { toTerminalEvent } from './conversation-result-builder.js';
import { type SavedToolExecution } from './tool-execution-ledger.js';
import { describeError } from '../utils/error-helpers.js';
import type { UserTurn } from '../types/user-turn.js';
import { SessionStreamProcessor } from './session-stream-processor.js';

/**
 * Callback signature for buildAndResolve: processes a resolved stream into
 * conversation events and a final terminal result.
 */
export type BuildAndResolveFn = (
  result: AgentStream,
  finalOutputOverride: string | undefined,
  reasoningOutputOverride: string | undefined,
  emittedCommandIds: Set<string> | undefined,
  usage: NormalizedUsage | undefined,
) => AsyncGenerator<ConversationEvent, ConversationTerminal, void>;

/** Callback: yield events from restarting the full turn. */
export type RestartTurnFn = (
  turn: { text: string },
  options: { skipUserMessage: boolean; retries: { transientRetryCount: number } },
) => AsyncIterable<ConversationEvent>;

// Callback types have been refactored

export interface ApprovalContinuationRunnerDeps {
  agentClient: ConversationAgentClient;
  approvalFlow: ApprovalFlowCoordinator;
  toolTracker: SessionToolTracker;
  conversationStore: ConversationStore;
  conversationLogger: ConversationLogger;
  retryOrchestrator: SessionRetryOrchestrator;
  inputPlanner: SessionInputPlanner;
  state: { previousResponseId: string | null };
  logger: ILoggingService;
  sessionId: string;
  streamProcessor: SessionStreamProcessor;

  // Callbacks into the owning session
  buildAndResolve: BuildAndResolveFn;
  restartTurn: RestartTurnFn;
}

export class ApprovalContinuationRunner {
  constructor(private readonly deps: ApprovalContinuationRunnerDeps) {}

  /**
   * Continue a session after an approval decision.
   * Yields conversation events and terminates when the continuation completes.
   */
  async *continueAfterApproval({
    answer,
    rejectionReason,
    generation: gen,
  }: {
    answer: string;
    rejectionReason?: string;
    generation: number;
  }): AsyncIterable<ConversationEvent> {
    const plan = this.deps.approvalFlow.prepareContinuation(answer, rejectionReason);
    if (!plan) {
      return;
    }

    if (answer !== 'y') {
      const interruption = plan.pendingApprovalContext.interruption;
      const callId = getCallIdFromObject(interruption);
      const output = rejectionReason
        ? `Tool execution was not approved. User's reason: ${rejectionReason}`
        : 'Tool execution was not approved.';
      this.deps.toolTracker.recordAbortedApproval(output, output, callId);
    }

    const {
      pendingApprovalContext: { state, interruption, toolCallArgumentsById, emittedCommandIds: previouslyEmittedIds },
      toolStartedEvent,
      removeInterceptor,
    } = plan;
    const ledgerSnapshot = this.deps.toolTracker.export();
    const approvedToolResultCallIds = [getCallIdFromObject(interruption)].filter(
      (callId): callId is string => typeof callId === 'string' && callId.length > 0,
    );
    let stream: AgentStream | null = null;

    if (toolStartedEvent) {
      const filtered = this.deps.toolTracker.dedupeToolStarted(toolStartedEvent);
      if (filtered) yield filtered;
    }

    // Restore cached tool-call arguments so continuation outputs can attach them
    this.deps.toolTracker.clearArguments();
    if (toolCallArgumentsById?.size) {
      for (const [key, value] of toolCallArgumentsById.entries()) {
        this.deps.toolTracker.argumentsById.set(key, value);
      }
    }

    try {
      let transientRetryCount = 0;
      while (true) {
        try {
          const previousInputForSurge =
            this.deps.retryOrchestrator.inputSurgeKindState === 'full_history'
              ? this.deps.conversationStore.getHistory()
              : undefined;
          stream = (await this.deps.agentClient.continueRunStream(state, {
            previousResponseId: this.deps.state.previousResponseId,
            sessionId: this.deps.sessionId,
            toolResultCallIds: approvedToolResultCallIds,
          })) as AgentStream;

          const acc = yield* this.deps.streamProcessor.process(stream, {
            gen,
            source: 'continueRunStream',
            preserveExistingToolArgs: true,
          });

          this.deps.streamProcessor.finalize(stream, gen, 'continueRunStream');

          // Merge previously emitted command IDs with newly emitted ones
          // This prevents duplicates when result.history contains commands from the initial stream
          const allEmittedIds = new Set([...previouslyEmittedIds, ...acc.emittedCommandIds]);

          const resolvedResult = yield* this.deps.buildAndResolve(
            stream,
            acc.finalOutput || undefined,
            acc.reasoningOutput || undefined,
            allEmittedIds,
            acc.latestUsage,
          );

          if (resolvedResult.type === 'approval_required') {
            if (resolvedResult.approval.callId) {
              this.deps.toolTracker.recordFunctionCall({
                type: 'function_call',
                callId: resolvedResult.approval.callId,
                name: resolvedResult.approval.toolName,
                arguments: resolvedResult.approval.argumentsText,
              });
            }
            this.deps.logger.debug('Tool approval required', {
              eventType: 'approval.required',
              category: 'approval',
              phase: 'approval',
              sessionId: this.deps.sessionId,
              traceId: this.deps.logger.getCorrelationId(),
              toolName: resolvedResult.approval.toolName,
            });
            this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
              kind: this.deps.retryOrchestrator.inputSurgeKindState,
              previousInput: previousInputForSurge,
            });
            yield toTerminalEvent(resolvedResult);
            return;
          }

          this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
            kind: this.deps.retryOrchestrator.inputSurgeKindState,
            previousInput: previousInputForSurge,
          });
          yield toTerminalEvent(resolvedResult);
          return;
        } catch (error) {
          const maxTransientRetries = getMaxTransientRetries({
            streamMaxRetries: getMethod<[], number | undefined>(this.deps.agentClient, 'getStreamMaxRetries')?.call(
              this.deps.agentClient,
            ),
          });
          const decision = this.deps.retryOrchestrator.classifyForContinuation({
            error,
            transientRetryCount,
            stream,
            maxTransientRetries,
          });
          if (decision.kind !== 'transient') {
            throw error;
          }
          if (decision.kind === 'transient') {
            transientRetryCount = decision.attempt;
            this.deps.logger.warn('Transient error in continuation, retrying', {
              eventType: 'retry.transient',
              category: 'retry',
              phase: 'retry',
              retryType: 'upstream',
              retryAttempt: transientRetryCount,
              maxRetries: maxTransientRetries,
              sessionId: this.deps.sessionId,
              traceId: this.deps.logger.getCorrelationId(),
              errorMessage: error instanceof Error ? error.message : String(error),
              delayMs: decision.delay,
            });
            yield {
              type: 'retry',
              toolName: 'continuation',
              attempt: transientRetryCount,
              maxRetries: maxTransientRetries,
              errorMessage: error instanceof Error ? error.message : String(error),
              retryType: 'upstream',
            };
            await new Promise((resolve) => setTimeout(resolve, decision.delay));

            if (!this.deps.retryOrchestrator.isCurrentGeneration(gen)) return;

            if (!stream) {
              this.#recoverApprovedToolResultsFromState(state, approvedToolResultCallIds);
              this.#commonRestoreForRetry(ledgerSnapshot, stream);

              const lastUserText = this.deps.conversationStore.getLastUserMessage();
              const dummyTurn: UserTurn = { text: lastUserText };
              yield* this.deps.restartTurn(dummyTurn, {
                skipUserMessage: true,
                retries: { transientRetryCount },
              });
              return;
            }

            // Rollback the tool ledger to the state right before this continuation started
            this.deps.toolTracker.import(ledgerSnapshot);

            // Loop again to retry the continueRunStream call
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      this.deps.logger.error('Conversation stream error during continuation', {
        eventType: 'stream.failed',
        category: 'stream',
        phase: 'abort',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        errorMessage: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      yield {
        type: 'error' as const,
        message: describeError(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      };
      throw error;
    } finally {
      // Clean up interceptor if one was added for rejection reason
      removeInterceptor();
    }
  }

  #recoverApprovedToolResultsFromState(state: unknown, expectedCallIds: readonly string[]): void {
    this.deps.toolTracker.recoverApprovedResultsFromState(state, expectedCallIds);
  }

  #commonRestoreForRetry(ledgerSnapshot: SavedToolExecution[], stream: AgentStream | null): void {
    this.deps.retryOrchestrator.restoreForRetry({
      ledgerSnapshot,
      stream,
      toolLedger: this.deps.toolTracker.ledger,
      conversationStore: this.deps.conversationStore,
      clearPreviousResponseId: () => {
        this.deps.state.previousResponseId = null;
        this.deps.inputPlanner.previousResponseId = null;
      },
      restoreCompletedToolLedgerEntries: (snapshot) => this.deps.toolTracker.restoreCompletedEntries(snapshot),
    });
  }
}
