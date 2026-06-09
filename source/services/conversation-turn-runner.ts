import type { ILoggingService } from './service-interfaces.js';
import type { AgentInputItem } from '@openai/agents';
import { getMaxTransientRetries } from './conversation-retry-policy.js';
import type { RetryState, SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import type { ConversationEvent } from './conversation-events.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import { getMethod, getCallIdFromObject } from './interruption-info.js';
import type { AgentStream } from './agent-stream.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import { reconcileHistoryWithToolLedger } from './tool-execution-ledger.js';
import { type SavedToolExecution } from './tool-execution-ledger.js';
import { ChainingTransportDowngradeError } from '../providers/fallback-responses-model.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { describeError } from '../utils/error-helpers.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { SessionStateController } from './session-state-controller.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { ConversationStore } from './conversation-store.js';
import type { ConversationLogger } from './conversation-logger.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import { toTerminalEvent } from './conversation-result-builder.js';
import type { ConversationTerminal } from '../contracts/conversation.js';

// ── Public types ──────────────────────────────────────────────────

export type RestartTurnFn = (
  turn: { text: string; images?: UserTurn['images'] },
  options: { skipUserMessage?: boolean; retries?: { transientRetryCount?: number } },
) => AsyncIterable<ConversationEvent>;

export type BuildAndResolveFn = (
  result: AgentStream,
  finalOutputOverride: string | undefined,
  reasoningOutputOverride: string | undefined,
  emittedCommandIds: Set<string> | undefined,
  usage: NormalizedUsage | undefined,
) => AsyncGenerator<ConversationEvent, ConversationTerminal, void>;

type RetryHandlerContext = {
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
};

// ── Deps interface ─────────────────────────────────────────────────

export interface ConversationTurnRunnerDeps {
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
  state: SessionStateController;
  streamProcessor: SessionStreamProcessor;

  // Callbacks that must go back through the owning session
  breakChaining: () => void;
  buildAndResolve: BuildAndResolveFn;
  isCurrentGeneration: (gen: number) => boolean;
}

// ── Class ──────────────────────────────────────────────────────────

/**
 * Owns the main turn execution loop: starting a stream, processing events,
 * finalizing results, and dispatching retry decisions.
 *
 * ConversationSession.run() delegates to this class.
 */
export class ConversationTurnRunner {
  constructor(private readonly deps: ConversationTurnRunnerDeps) {}

  /**
   * Stream conversation events as an async iterator.
   *
   * This is the transport-friendly primitive that can later be bridged to SSE/WebSockets.
   */
  async *run(
    input: string | UserTurn,
    {
      skipUserMessage = false,
      retries = {},
      maxModelRetries,
      signal,
      resumeState,
    }: {
      skipUserMessage?: boolean;
      retries?: RetryState;
      maxModelRetries?: number;
      signal?: AbortSignal;
      resumeState?: unknown;
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
    const gen = this.deps.retryOrchestrator.currentGeneration;
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
      const abortedContext = this.deps.approvalFlow.consumeAborted();
      const shouldAddUserMessage = !skipUserMessage && !abortedContext;

      // Maintain canonical local history regardless of provider.
      if (shouldAddUserMessage) {
        this.deps.conversationStore.addUserTurn(turn);
        addedUserMessage = true;
      } else if (abortedContext && !skipUserMessage) {
        // The UI appended a user message for this input, but the store will consume it
        // as fake tool output for the aborted approval rather than as a new user turn.
        // Signal the UI to mark it so /undo skips it.
        yield { type: 'user_message_consumed_for_abort' };
      }

      // If there's an aborted approval, we need to resolve it first.
      // The user's message is a new input, but the agent is stuck waiting for tool output.
      if (abortedContext) {
        this.deps.logger.debug('Resolving aborted approval with fake execution', {
          message: text,
        });

        // Restore cached tool-call arguments captured before abort so continuation can attach them
        this.deps.toolTracker.clearArguments();
        if (abortedContext.toolCallArgumentsById?.size) {
          for (const [key, value] of abortedContext.toolCallArgumentsById.entries()) {
            this.deps.toolTracker.argumentsById.set(key, value);
          }
        }

        const { removeInterceptor } = this.deps.approvalFlow.prepareAbortResolution(abortedContext, text);

        try {
          const previousInputForSurge =
            this.deps.retryOrchestrator.inputSurgeKindState === 'full_history'
              ? this.deps.conversationStore.getHistory()
              : undefined;
          const continuedStream = (await this.deps.agentClient.continueRunStream(abortedContext.state, {
            previousResponseId: this.deps.state.previousResponseId,
            sessionId: this.deps.sessionId,
            toolResultCallIds: [getCallIdFromObject(abortedContext.interruption)].filter(
              (callId): callId is string => typeof callId === 'string' && callId.length > 0,
            ),
          })) as AgentStream;

          const acc = yield* this.deps.streamProcessor.process(continuedStream, {
            gen,
            source: 'abortResolution',
            preserveExistingToolArgs: true,
            previouslyEmittedCommandIds: abortedContext.emittedCommandIds,
          });

          this.deps.streamProcessor.finalize(continuedStream, gen, 'abortResolution');

          if (continuedStream.interruptions && continuedStream.interruptions.length > 0) {
            this.deps.logger.warn('Another interruption occurred after fake execution - handling as approval');
          }

          // Successfully resolved - agent should now have processed the fake rejection
          this.deps.logger.debug('Fake execution completed, agent received rejection message');

          const resolvedResult = yield* this.deps.buildAndResolve(
            continuedStream,
            acc.finalOutput,
            acc.reasoningOutput,
            acc.emittedCommandIds,
            acc.latestUsage,
          );
          this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
            kind: this.deps.retryOrchestrator.inputSurgeKindState,
            previousInput: previousInputForSurge,
          });
          yield toTerminalEvent(resolvedResult);
          return;
        } catch (error) {
          this.deps.logger.warn('Error resolving aborted approval with fake execution', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Fall through to normal message flow
        } finally {
          // Always remove interceptor after use
          removeInterceptor();
        }
      }

      // Normal message flow
      // Use chaining mode only when the provider supports it AND either a valid
      // chain exists (previousResponseId is set) or there is no prior history to
      // resync (fresh start with just the current message). After undo the chain
      // is severed (previousResponseId = null) while prior turns remain in the
      // local store, so we fall back to full-history mode to re-establish context.
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
        if (addedUserMessage && this.deps.isCurrentGeneration(gen)) {
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
            previousResponseId: this.deps.state.previousResponseId,
            sessionId: this.deps.sessionId,
          })) as AgentStream;
        } else {
          stream = (await this.deps.agentClient.startStream(streamInput, {
            previousResponseId: inputSurgeKind === 'delta' ? this.deps.state.previousResponseId : null,
            sessionId: this.deps.sessionId,
          })) as AgentStream;
        }
      } catch (chainingError) {
        // When WS degrades to HTTP mid-request and the provider requires WS for
        // chaining (e.g. Codex), the model layer throws ChainingTransportDowngradeError.
        // Break chaining and retry with full history.
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

      this.deps.streamProcessor.finalize(stream, gen, 'startStream');

      const resolvedResult = yield* this.deps.buildAndResolve(
        stream,
        acc.finalOutput || undefined,
        acc.reasoningOutput || undefined,
        acc.emittedCommandIds,
        acc.latestUsage,
      );

      this.deps.inputPlanner.recordSuccess(
        inputSurgeKind === 'delta' ? streamInput : this.deps.conversationStore.getHistory(),
        inputSurgeKind === 'delta' ? { kind: inputSurgeKind } : { kind: inputSurgeKind, previousInput: streamInput },
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
        yield toTerminalEvent(resolvedResult);
        return;
      }

      yield toTerminalEvent(resolvedResult);
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

  // ── Internal helpers ────────────────────────────────────────────

  /**
   * Restore state for a retry attempt.
   */
  #commonRestoreForRetry(
    ledgerSnapshot: SavedToolExecution[],
    stream: AgentStream | null,
    extras?: { removeLastUserMessage?: boolean },
  ): void {
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
      ...(extras?.removeLastUserMessage
        ? { removeLastUserMessage: () => this.deps.conversationStore.removeLastUserMessage() }
        : {}),
    });
  }

  /**
   * Classify a streaming error and either retry the turn or yield error/cleanup events.
   * Returns true when the error was handled (retry dispatched or generation stale),
   * false when the caller should throw the original error.
   */
  async *#handleRetryDecision(ctx: RetryHandlerContext): AsyncGenerator<ConversationEvent, boolean> {
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

    const outcome = yield* this.deps.retryOrchestrator.handleRetryDecision({
      error,
      turn,
      gen,
      stream,
      retries,
      maxTransientRetries,
      maxModelRetries,
    });

    switch (outcome.kind) {
      case 'stale_generation':
        return true;
      case 'retry_flex_fallback': {
        getMethod<[], void>(this.deps.agentClient, 'useStandardServiceTierForNextRequest')?.call(this.deps.agentClient);
        this.#commonRestoreForRetry(ledgerSnapshot, stream);
        yield* this.run(turn, outcome.runOptions);
        return true;
      }
      case 'retry_transient': {
        if (outcome.restoreOptions) {
          this.#commonRestoreForRetry(ledgerSnapshot, stream, outcome.restoreOptions);
        }
        yield* this.run(turn, outcome.runOptions);
        return true;
      }
      case 'retry_transport_downgrade': {
        this.#commonRestoreForRetry(ledgerSnapshot, stream, outcome.restoreOptions);
        yield* this.run(turn, outcome.runOptions);
        return true;
      }
      case 'retry_hallucination': {
        if (outcome.hadStream && stream) {
          this.deps.toolTracker.import(ledgerSnapshot);
          if (outcome.addErrorContext) {
            this.deps.conversationStore.addErrorContext(outcome.addErrorContext);
          }
        } else {
          this.deps.conversationStore.removeLastUserMessage();
        }
        yield* this.run(turn, outcome.runOptions);
        return true;
      }
    }

    // Drop the just-added user turn from the store before yielding so the
    // generator-cleanup path doesn't strand the removal — and so the error
    // event can carry the dropped text for UI restoration.
    let droppedUserMessage: { text: string; imageCount: number } | undefined;
    if (addedUserMessage && !stream && this.deps.isCurrentGeneration(gen)) {
      this.deps.conversationStore.removeLastUserMessage();
      droppedUserMessage = { text: turn.text, imageCount: turn.images?.length ?? 0 };
    }
    if (stream && this.deps.isCurrentGeneration(gen)) {
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
}
