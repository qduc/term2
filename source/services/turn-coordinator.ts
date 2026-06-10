import { type RunState, type AgentInputItem } from '@openai/agents';
import type { ILoggingService } from './service-interfaces.js';
import { type RetryState, SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { type NormalizedUsage } from '../utils/token-usage.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationStore } from './conversation-store.js';
import { ConversationLogger } from './conversation-logger.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionStateController } from './session-state-controller.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { ConversationAgentClient } from './conversation-agent-client.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ConversationTerminal } from '../contracts/conversation.js';
import { getCallIdFromObject, getMethod } from './interruption-info.js';
import { getMaxTransientRetries } from './conversation-retry-policy.js';
import { toTerminalEvent, buildConversationResult } from './conversation-result-builder.js';
import { type SavedToolExecution, reconcileHistoryWithToolLedger } from './tool-execution-ledger.js';
import { describeError } from '../utils/error-helpers.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';
import { ChainingTransportDowngradeError } from '../providers/fallback-responses-model.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';
import type { AgentStream } from './agent-stream.js';
import { type PendingApprovalContext } from './approval-state.js';

export type SessionStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'continuing';

export class ApplicationSessionState {
  status: SessionStatus = 'idle';
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
  state: SessionStateController;
  streamProcessor: SessionStreamProcessor;
  appState: ApplicationSessionState;
  breakChaining: () => void;
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
    if (this.deps.appState.status !== 'idle') {
      throw new Error('Another foreground turn is already active.');
    }
    this.deps.appState.status = 'streaming';
    try {
      yield* this.#executeRun(input, options);
    } finally {
      if (this.deps.appState.status === 'streaming' || this.deps.appState.status === 'continuing') {
        this.deps.appState.status = 'idle';
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
    if (this.deps.appState.status !== 'awaiting_approval') {
      throw new Error('No pending approval to continue.');
    }
    this.deps.appState.status = 'continuing';
    try {
      yield* this.#executeContinuation({
        answer,
        rejectionReason,
        generation: this.deps.retryOrchestrator.currentGeneration,
      });
    } finally {
      if (this.deps.appState.status === 'continuing' || this.deps.appState.status === 'streaming') {
        this.deps.appState.status = 'idle';
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
    this.deps.appState.status = 'idle';
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
    }: {
      skipUserMessage?: boolean;
      retries?: RetryState;
      maxModelRetries?: number;
      signal?: AbortSignal;
      resumeState?: RunState<any, any>;
      resumePreviousResponseId?: string | null;
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

      if (shouldAddUserMessage) {
        this.deps.conversationStore.addUserTurn(turn);
        addedUserMessage = true;
      } else if (abortedContext && !skipUserMessage) {
        yield { type: 'user_message_consumed_for_abort' };
      }

      if (abortedContext) {
        this.deps.logger.debug('Resolving aborted approval with fake execution', {
          message: text,
        });

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

          this.deps.logger.debug('Fake execution completed, agent received rejection message');

          const resolvedResult = yield* this.#buildAndResolve(
            continuedStream,
            acc.finalOutput || undefined,
            acc.reasoningOutput || undefined,
            acc.emittedCommandIds,
            acc.latestUsage,
          );

          this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
            kind: this.deps.retryOrchestrator.inputSurgeKindState,
            previousInput: previousInputForSurge,
          });

          if (resolvedResult.type === 'approval_required') {
            this.deps.appState.status = 'awaiting_approval';
          }
          yield toTerminalEvent(resolvedResult);
          return;
        } catch (error) {
          this.deps.logger.warn('Error resolving aborted approval with fake execution', {
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          removeInterceptor();
        }
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
            previousResponseId: resumePreviousResponseId ?? this.deps.state.previousResponseId,
            sessionId: this.deps.sessionId,
          })) as AgentStream;
        } else {
          stream = (await this.deps.agentClient.startStream(streamInput, {
            previousResponseId: inputSurgeKind === 'delta' ? this.deps.state.previousResponseId : null,
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

      this.deps.streamProcessor.finalize(stream, gen, 'startStream');

      const resolvedResult = yield* this.#buildAndResolve(
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
        this.deps.appState.status = 'awaiting_approval';
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

  async *#executeContinuation({
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

          const allEmittedIds = new Set([...previouslyEmittedIds, ...acc.emittedCommandIds]);

          const resolvedResult = yield* this.#buildAndResolve(
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
            this.deps.appState.status = 'awaiting_approval';
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

            // Transition status to continuing/streaming as we restart executing
            this.deps.appState.status = 'streaming';
            yield* this.#executeRun(dummyTurn, {
              skipUserMessage: true,
              retries: { transientRetryCount },
            });
            return;
          }

          this.deps.toolTracker.import(ledgerSnapshot);
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
      removeInterceptor();
    }
  }

  async *#buildAndResolve(
    result: AgentStream,
    finalOutputOverride: string | undefined,
    reasoningOutputOverride: string | undefined,
    emittedCommandIds: Set<string> | undefined,
    usage: NormalizedUsage | undefined,
  ): AsyncGenerator<ConversationEvent, ConversationTerminal, void> {
    const outcome = await buildConversationResult(
      {
        result,
        finalOutputOverride,
        reasoningOutputOverride,
        emittedCommandIds,
        usage,
        toolCallArgumentsById: this.deps.toolTracker.argumentsById,
        turnItems: this.deps.turnAccumulator.getTurnItems(),
      },
      {
        approvalFlow: this.deps.approvalFlow,
        shellAutoApproval: this.deps.shellAutoApproval,
        logger: this.deps.logger,
        sessionId: this.deps.sessionId,
      },
    );

    if (outcome.kind !== 'auto_approve') {
      return outcome.result;
    }

    let finalText = '';
    let reasoningText = '';
    let finalUsage: NormalizedUsage | undefined;
    let continuationApprovalUsage: NormalizedUsage | undefined;
    const commandMessages: CommandMessage[] = [];
    let approvalRequiredResult: ConversationTerminal | undefined;
    let continuationTurnItems: PersistedAssistantTurnItem[] | undefined;

    // Save current status and temporarily switch to 'continuing' for auto-approval continuation
    const originalStatus = this.deps.appState.status;
    this.deps.appState.status = 'continuing';

    try {
      for await (const event of this.#executeContinuation({
        answer: 'y',
        generation: this.deps.retryOrchestrator.currentGeneration,
      })) {
        if (event.type === 'approval_required') {
          continuationApprovalUsage = event.usage;
          const mergedUsage = continuationApprovalUsage ?? usage;
          const usagePatch = mergedUsage && Object.keys(mergedUsage).length > 0 ? { usage: mergedUsage } : {};

          yield { ...event, ...usagePatch };

          approvalRequiredResult = {
            type: 'approval_required',
            approval: {
              ...event.approval,
              rawInterruption: this.deps.approvalFlow.getPendingInterruption(),
            },
            ...usagePatch,
          };
        } else if (event.type === 'final') {
          finalText = event.finalText;
          reasoningText = event.reasoningText ?? '';
          finalUsage = event.usage;
          if (event.commandMessages) {
            commandMessages.push(...event.commandMessages);
          }
          if (event.turnItems) {
            continuationTurnItems = event.turnItems;
          }
        } else {
          yield event;
        }
      }
    } finally {
      this.deps.appState.status = originalStatus;
    }

    if (approvalRequiredResult) {
      return approvalRequiredResult;
    }

    const combinedUsage = finalUsage ?? usage;
    return {
      type: 'response',
      commandMessages,
      finalText: finalText || 'Done.',
      ...(reasoningText ? { reasoningText } : {}),
      ...(combinedUsage && Object.keys(combinedUsage).length > 0 ? { usage: combinedUsage } : {}),
      turnItems: continuationTurnItems ?? this.deps.turnAccumulator.getTurnItems(),
    };
  }

  #recoverApprovedToolResultsFromState(state: unknown, expectedCallIds: readonly string[]): void {
    this.deps.toolTracker.recoverApprovedResultsFromState(state, expectedCallIds);
  }

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
        yield* this.#executeRun(turn, outcome.runOptions);
        return true;
      }
      case 'retry_transient': {
        if (outcome.restoreOptions) {
          this.#commonRestoreForRetry(ledgerSnapshot, stream, outcome.restoreOptions);
        }
        yield* this.#executeRun(turn, outcome.runOptions);
        return true;
      }
      case 'retry_transport_downgrade': {
        this.#commonRestoreForRetry(ledgerSnapshot, stream, outcome.restoreOptions);
        yield* this.#executeRun(turn, outcome.runOptions);
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
        yield* this.#executeRun(turn, outcome.runOptions);
        return true;
      }
    }

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
}
