import type { RunState } from '@openai/agents';
import type { ILoggingService } from './service-interfaces.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { type NormalizedUsage } from '../utils/token-usage.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ConversationStore } from './conversation-store.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import type { SessionStreamProcessor, StreamHistorySource } from './session-stream-processor.js';
import type { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import type { SessionRetryOrchestrator, RetryState } from './session-retry-orchestrator.js';
import type { ProviderContinuity } from './provider-continuity.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import type { AgentStream } from './agent-stream.js';
import type { ConversationTerminal, LLMAdvisory } from '../contracts/conversation.js';
import type { AbortedApprovalContext } from './approval-state.js';
import { GenerationGuard } from './generation-guard.js';

import { buildConversationResult } from './conversation-result-builder.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from './interruption-info.js';
import { getMaxTransientRetries } from './conversation-retry-policy.js';
import { getMethod } from './interruption-info.js';
import { describeError } from '../utils/error-helpers.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';

// ── Approval Decision Policy ──────────────────────────────────────

export interface ApprovalContext {
  toolName: string;
  argumentsText: string;
  callId?: string;
  llmAdvisory?: LLMAdvisory;
}

export interface ApprovalDecisionPolicy {
  decide(context: ApprovalContext): Promise<'approve' | 'reject' | 'prompt'>;
}

export class ManualApprovalDecisionPolicy implements ApprovalDecisionPolicy {
  async decide(): Promise<'prompt'> {
    return 'prompt';
  }
}

export class ShellAutoApprovalDecisionPolicy implements ApprovalDecisionPolicy {
  constructor(private readonly shellAutoApproval: ShellAutoApprovalResolver) {}

  async decide(context: ApprovalContext): Promise<'approve' | 'prompt'> {
    if (context.toolName !== 'shell' && context.toolName !== 'bash') return 'prompt';
    if (!context.llmAdvisory) return 'prompt';
    if (this.shellAutoApproval.shouldAutoApprove(context.llmAdvisory)) return 'approve';
    return 'prompt';
  }
}

// ── Continuation Driver Types ──────────────────────────────────────

export type ContinuationInit =
  | {
      kind: 'approval_decision';
      answer: string;
      rejectionReason?: string;
      generation: number;
    }
  | {
      kind: 'abort_resolution';
      abortedContext: AbortedApprovalContext;
      userText: string;
      generation: number;
    };

export type ContinuationDriveResult =
  | { kind: 'approval_required'; result: ConversationTerminal }
  | { kind: 'response'; result: ConversationTerminal }
  | { kind: 'fresh_start_required'; retries: RetryState };

export interface ContinuationDriverDeps {
  agentClient: ConversationAgentClient;
  logger: ILoggingService;
  sessionId: string;
  toolTracker: SessionToolTracker;
  streamProcessor: SessionStreamProcessor;
  approvalFlow: ApprovalFlowCoordinator;
  retryOrchestrator: SessionRetryOrchestrator;
  providerContinuity: ProviderContinuity;
  inputPlanner: SessionInputPlanner;
  conversationStore: ConversationStore;
  turnAccumulator: TurnItemAccumulator;
  shellAutoApproval: ShellAutoApprovalResolver;
  generationGuard: GenerationGuard;
}

// ── Prepared Continuation ─────────────────────────────────────────

interface PreparedContinuation {
  state: RunState<any, any>;
  interruption: unknown;
  toolCallArgumentsById: Map<string, unknown>;
  previouslyEmittedCommandIds: Set<string>;
  toolStartedEvent?: ConversationEvent;
  removeInterceptor: () => void;
  source: StreamHistorySource;
}

// ── ContinuationDriver ────────────────────────────────────────────

export class ContinuationDriver {
  constructor(private readonly deps: ContinuationDriverDeps) {}

  async *drive(
    init: ContinuationInit,
    policy: ApprovalDecisionPolicy,
  ): AsyncGenerator<ConversationEvent, ContinuationDriveResult, void> {
    const prepared = this.#prepareInit(init);

    if (prepared.toolStartedEvent) {
      const filtered = this.deps.toolTracker.dedupeToolStarted(prepared.toolStartedEvent);
      if (filtered) yield filtered;
    }

    this.deps.toolTracker.clearArguments();
    if (prepared.toolCallArgumentsById?.size) {
      for (const [key, value] of prepared.toolCallArgumentsById.entries()) {
        this.deps.toolTracker.argumentsById.set(key, value);
      }
    }

    const approvedToolResultCallIds = [getCallIdFromObject(prepared.interruption)].filter(
      (callId): callId is string => typeof callId === 'string' && callId.length > 0,
    );

    let ledgerSnapshot = this.deps.toolTracker.export();
    let source: StreamHistorySource = prepared.source;
    let previouslyEmittedIds = prepared.previouslyEmittedCommandIds;
    let currentState = prepared.state;
    let currentCallIds = approvedToolResultCallIds;

    let cumulativeUsage: NormalizedUsage | undefined;
    const cumulativeCommandMessages: CommandMessage[] = [];
    let cumulativeTurnItems: PersistedAssistantTurnItem[] | undefined;

    let transientRetryCount = 0;
    let lastStream: AgentStream | null = null;

    try {
      while (true) {
        try {
          const previousInputForSurge =
            this.deps.retryOrchestrator.inputSurgeKindState === 'full_history'
              ? this.deps.conversationStore.getHistory()
              : undefined;

          const stream = (await this.deps.agentClient.continueRunStream(currentState, {
            previousResponseId: this.deps.providerContinuity.previousResponseId,
            sessionId: this.deps.sessionId,
            toolResultCallIds: currentCallIds,
          })) as AgentStream;
          lastStream = stream;

          const allEmittedIds = new Set([...previouslyEmittedIds]);

          const acc = yield* this.deps.streamProcessor.process(stream, {
            gen: init.generation,
            source,
            preserveExistingToolArgs: true,
            previouslyEmittedCommandIds: allEmittedIds,
          });

          this.deps.streamProcessor.finalize(
            stream,
            init.generation,
            this.deps.retryOrchestrator.inputSurgeKindState,
            source,
          );

          const mergedEmittedIds = new Set([...allEmittedIds, ...acc.emittedCommandIds]);

          const outcome = await buildConversationResult(
            {
              result: stream,
              finalOutputOverride: acc.finalOutput || undefined,
              reasoningOutputOverride: acc.reasoningOutput || undefined,
              emittedCommandIds: mergedEmittedIds,
              usage: acc.latestUsage,
              toolCallArgumentsById: this.deps.toolTracker.argumentsById,
              turnItems: this.deps.turnAccumulator.getTurnItems(),
              token: init.generation,
            },
            {
              approvalFlow: this.deps.approvalFlow,
              shellAutoApproval: this.deps.shellAutoApproval,
              logger: this.deps.logger,
              sessionId: this.deps.sessionId,
            },
          );

          if (outcome.kind === 'response') {
            this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
              kind: this.deps.retryOrchestrator.inputSurgeKindState,
              previousInput: previousInputForSurge,
            });

            const mergedUsage = acc.latestUsage ?? cumulativeUsage;
            if (outcome.result.type === 'response') {
              const result: ConversationTerminal = {
                type: 'response',
                commandMessages: [...cumulativeCommandMessages, ...(outcome.result.commandMessages ?? [])],
                finalText: outcome.result.finalText,
                ...(outcome.result.reasoningText ? { reasoningText: outcome.result.reasoningText } : {}),
                ...(mergedUsage && Object.keys(mergedUsage).length > 0 ? { usage: mergedUsage } : {}),
                turnItems: outcome.result.turnItems ?? cumulativeTurnItems ?? this.deps.turnAccumulator.getTurnItems(),
              };
              return { kind: 'response', result };
            }

            return { kind: 'response', result: outcome.result };
          }

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

            cumulativeUsage = acc.latestUsage ?? cumulativeUsage;

            const nextPlan = this.deps.approvalFlow.prepareContinuation('y', undefined);
            if (!nextPlan) {
              const approvalFallback = this.#buildApprovalRequiredFromAutoApprove(outcome, acc.latestUsage);
              return { kind: 'approval_required', result: approvalFallback };
            }

            if (nextPlan.toolStartedEvent) {
              const filtered = this.deps.toolTracker.dedupeToolStarted(nextPlan.toolStartedEvent);
              if (filtered) yield filtered;
            }

            this.deps.toolTracker.clearArguments();
            if (nextPlan.pendingApprovalContext.toolCallArgumentsById?.size) {
              for (const [key, value] of nextPlan.pendingApprovalContext.toolCallArgumentsById.entries()) {
                this.deps.toolTracker.argumentsById.set(key, value);
              }
            }

            currentState = nextPlan.pendingApprovalContext.state;
            currentCallIds = [getCallIdFromObject(nextPlan.pendingApprovalContext.interruption)].filter(
              (callId): callId is string => typeof callId === 'string' && callId.length > 0,
            );
            source = 'continueRunStream';
            previouslyEmittedIds = mergedEmittedIds;
            ledgerSnapshot = this.deps.toolTracker.export();

            continue;
          }

          const approvalContext: ApprovalContext = {
            toolName: outcome.result.approval.toolName,
            argumentsText: outcome.result.approval.argumentsText,
            callId: outcome.result.approval.callId,
            llmAdvisory: outcome.result.approval.llmAdvisory,
          };

          const decision = await policy.decide(approvalContext);

          if (decision === 'prompt') {
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
            this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
              kind: this.deps.retryOrchestrator.inputSurgeKindState,
              previousInput: previousInputForSurge,
            });

            const mergedUsage = acc.latestUsage ?? cumulativeUsage;
            const usagePatch = mergedUsage && Object.keys(mergedUsage).length > 0 ? { usage: mergedUsage } : {};

            const resultWithUsage: ConversationTerminal = {
              ...outcome.result,
              ...usagePatch,
            };
            return { kind: 'approval_required', result: resultWithUsage };
          }

          cumulativeUsage = acc.latestUsage ?? cumulativeUsage;

          if (decision === 'approve') {
            this.deps.logger.debug('Shell command auto-approved by policy', {
              eventType: 'approval.auto_approved',
              category: 'approval',
              phase: 'approval',
              sessionId: this.deps.sessionId,
              traceId: this.deps.logger.getCorrelationId(),
              callId: approvalContext.callId,
              command: approvalContext.argumentsText,
            });
          }

          const answer = decision === 'approve' ? 'y' : 'n';
          const nextPlan = this.deps.approvalFlow.prepareContinuation(answer, undefined);
          if (!nextPlan) {
            return { kind: 'approval_required', result: outcome.result };
          }

          if (answer !== 'y') {
            const callId = getCallIdFromObject(nextPlan.pendingApprovalContext.interruption);
            this.deps.toolTracker.recordAbortedApproval(
              'Tool execution was not approved.',
              'Tool execution was not approved.',
              callId,
            );
          }

          if (nextPlan.toolStartedEvent) {
            const filtered = this.deps.toolTracker.dedupeToolStarted(nextPlan.toolStartedEvent);
            if (filtered) yield filtered;
          }

          this.deps.toolTracker.clearArguments();
          if (nextPlan.pendingApprovalContext.toolCallArgumentsById?.size) {
            for (const [key, value] of nextPlan.pendingApprovalContext.toolCallArgumentsById.entries()) {
              this.deps.toolTracker.argumentsById.set(key, value);
            }
          }

          currentState = nextPlan.pendingApprovalContext.state;
          currentCallIds = [getCallIdFromObject(nextPlan.pendingApprovalContext.interruption)].filter(
            (callId): callId is string => typeof callId === 'string' && callId.length > 0,
          );
          source = 'continueRunStream';
          previouslyEmittedIds = mergedEmittedIds;
          ledgerSnapshot = this.deps.toolTracker.export();

          continue;
        } catch (error) {
          const maxTransientRetries = getMaxTransientRetries({
            streamMaxRetries: getMethod<[], number | undefined>(this.deps.agentClient, 'getStreamMaxRetries')?.call(
              this.deps.agentClient,
            ),
          });
          const retryStream = lastStream;
          const decision = this.deps.retryOrchestrator.classifyForContinuation({
            error,
            transientRetryCount,
            stream: retryStream,
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

          if (!this.deps.retryOrchestrator.isCurrentGeneration(init.generation)) {
            return { kind: 'fresh_start_required', retries: { transientRetryCount } };
          }

          if (!retryStream) {
            this.deps.toolTracker.recoverApprovedResultsFromState(currentState, currentCallIds);
            this.deps.retryOrchestrator.restoreForRetry({
              ledgerSnapshot,
              stream: null,
              toolLedger: this.deps.toolTracker.ledger,
              conversationStore: this.deps.conversationStore,
              clearPreviousResponseId: () => {
                this.deps.providerContinuity.clear();
              },
              restoreCompletedToolLedgerEntries: (snapshot) => this.deps.toolTracker.restoreCompletedEntries(snapshot),
            });

            return { kind: 'fresh_start_required', retries: { transientRetryCount } };
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
      prepared.removeInterceptor();
    }
  }

  #prepareInit(init: ContinuationInit): PreparedContinuation {
    if (init.kind === 'approval_decision') {
      const plan = this.deps.approvalFlow.prepareContinuation(init.answer, init.rejectionReason);
      if (!plan) {
        throw new Error('No pending approval for continuation');
      }

      if (init.answer !== 'y') {
        const callId = getCallIdFromObject(plan.pendingApprovalContext.interruption);
        const output = init.rejectionReason
          ? `Tool execution was not approved. User's reason: ${init.rejectionReason}`
          : 'Tool execution was not approved.';
        this.deps.toolTracker.recordAbortedApproval(output, output, callId);
      }

      return {
        state: plan.pendingApprovalContext.state,
        interruption: plan.pendingApprovalContext.interruption,
        toolCallArgumentsById: plan.pendingApprovalContext.toolCallArgumentsById,
        previouslyEmittedCommandIds: plan.pendingApprovalContext.emittedCommandIds,
        toolStartedEvent: plan.toolStartedEvent,
        removeInterceptor: plan.removeInterceptor,
        source: 'continueRunStream',
      };
    }

    const { abortedContext } = init;
    const plan = this.deps.approvalFlow.prepareAbortResolution(abortedContext, init.userText);

    return {
      state: abortedContext.state,
      interruption: abortedContext.interruption,
      toolCallArgumentsById: abortedContext.toolCallArgumentsById,
      previouslyEmittedCommandIds: abortedContext.emittedCommandIds,
      toolStartedEvent: undefined,
      removeInterceptor: plan.removeInterceptor,
      source: 'abortResolution',
    };
  }

  #buildApprovalRequiredFromAutoApprove(
    outcome: Extract<import('./conversation-result-builder.js').BuildResultOutcome, { kind: 'auto_approve' }>,
    usage?: NormalizedUsage,
  ): ConversationTerminal {
    const pending = this.deps.approvalFlow.getPending();
    if (pending) {
      const { toolName, argumentsText } = getToolInfoFromInterruption(pending.interruption);
      const agent =
        pending.interruption && typeof pending.interruption === 'object'
          ? (pending.interruption as Record<string, unknown>).agent
          : undefined;
      const agentName = agent && typeof agent === 'object' ? (agent as Record<string, unknown>).name : 'Agent';
      const callId = getCallIdFromObject(pending.interruption);

      return {
        type: 'approval_required',
        approval: {
          agentName: typeof agentName === 'string' ? agentName : 'Agent',
          toolName: toolName ?? 'Unknown Tool',
          argumentsText,
          rawInterruption: pending.interruption,
          ...(callId ? { callId: String(callId) } : {}),
          llmAdvisory: outcome.advisory,
        },
        usage,
      };
    }

    return {
      type: 'approval_required',
      approval: {
        agentName: 'Agent',
        toolName: 'Unknown Tool',
        argumentsText: outcome.argumentsText,
        rawInterruption: undefined,
        ...(outcome.callId ? { callId: outcome.callId } : {}),
        llmAdvisory: outcome.advisory,
      },
      usage,
    };
  }
}
