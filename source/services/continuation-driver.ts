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

import type { DefaultRetryClassifier } from './retry-classifier.js';
import type { DefaultConversationRecoveryPolicy } from './recovery-policy.js';
import type { DefaultRecoveryExecutor } from './recovery-executor.js';
import type { RetryEventPresenter } from './retry-event-presenter.js';
import type { RetryCounts, RecoveryState } from './retry-contracts.js';
import { extractCommandMessages } from '../utils/extract-command-messages.js';

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
  | { kind: 'fresh_start_required'; retryCounts: RetryCounts }
  | { kind: 'stale' };

export interface ContinuationDriverDeps {
  agentClient: ConversationAgentClient;
  logger: ILoggingService;
  sessionId: string;
  toolTracker: SessionToolTracker;
  streamProcessor: SessionStreamProcessor;
  approvalFlow: ApprovalFlowCoordinator;
  providerContinuity: ProviderContinuity;
  inputPlanner: SessionInputPlanner;
  conversationStore: ConversationStore;
  turnAccumulator: TurnItemAccumulator;
  shellAutoApproval: ShellAutoApprovalResolver;
  generationGuard: GenerationGuard;
  retryClassifier: DefaultRetryClassifier;
  recoveryPolicy: DefaultConversationRecoveryPolicy;
  recoveryExecutor: DefaultRecoveryExecutor;
  retryEventPresenter: RetryEventPresenter;
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
  token?: import('./generation-guard.js').GenerationToken;
  inputMode?: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  cumulativeCommandMessages?: CommandMessage[];
  cumulativeTurnItems?: PersistedAssistantTurnItem[];
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

    const token = prepared.token ?? init.generation;
    let inputMode = prepared.inputMode ?? 'delta';

    let cumulativeUsage = prepared.cumulativeUsage;
    const cumulativeCommandMessages = prepared.cumulativeCommandMessages ? [...prepared.cumulativeCommandMessages] : [];

    let retryCounts: RetryCounts = {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    };
    let lastStream: AgentStream | null = null;
    let currentResumePreviousResponseId: string | null | undefined = undefined;

    try {
      while (true) {
        if (!this.deps.generationGuard.isCurrent(token)) {
          return { kind: 'stale' };
        }

        try {
          const previousInputForSurge =
            inputMode === 'full_history' ? this.deps.conversationStore.getHistory() : undefined;

          const stream = (await this.deps.agentClient.continueRunStream(currentState, {
            previousResponseId: currentResumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
            sessionId: this.deps.sessionId,
            toolResultCallIds: currentCallIds,
          })) as AgentStream;
          lastStream = stream;

          const allEmittedIds = new Set([...previouslyEmittedIds]);

          const acc = yield* this.deps.streamProcessor.process(stream, {
            gen: token,
            source,
            preserveExistingToolArgs: true,
            previouslyEmittedCommandIds: allEmittedIds,
          });

          const finalizeResult = this.deps.streamProcessor.finalize(stream, token, inputMode, source);
          if (finalizeResult.kind === 'stale') {
            return { kind: 'stale' };
          }

          const mergedEmittedIds = new Set([...allEmittedIds, ...acc.emittedCommandIds]);

          const streamMessages = extractCommandMessages(stream.newItems || stream.history || []);
          const filteredMessages = streamMessages.filter((msg) => !previouslyEmittedIds.has(msg.id));
          const nextCumulativeMessages = [...cumulativeCommandMessages, ...filteredMessages];
          const nextCumulativeUsage = acc.latestUsage ?? cumulativeUsage;
          const nextCumulativeTurnItems = this.deps.turnAccumulator.getTurnItems();

          const outcome = await buildConversationResult(
            {
              result: stream,
              finalOutputOverride: acc.finalOutput || undefined,
              reasoningOutputOverride: acc.reasoningOutput || undefined,
              emittedCommandIds: mergedEmittedIds,
              usage: acc.latestUsage,
              toolCallArgumentsById: this.deps.toolTracker.argumentsById,
              turnItems: nextCumulativeTurnItems,
              token,
              inputMode,
              cumulativeUsage: nextCumulativeUsage,
              cumulativeCommandMessages: nextCumulativeMessages,
              cumulativeTurnItems: nextCumulativeTurnItems,
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
              inputMode === 'delta' ? stream : this.deps.conversationStore.getHistory(),
              inputMode === 'delta' ? { kind: inputMode } : { kind: inputMode, previousInput: previousInputForSurge },
            );

            if (outcome.result.type === 'response') {
              const result: ConversationTerminal = {
                type: 'response',
                commandMessages: nextCumulativeMessages,
                finalText: outcome.result.finalText,
                ...(outcome.result.reasoningText ? { reasoningText: outcome.result.reasoningText } : {}),
                ...(nextCumulativeUsage && Object.keys(nextCumulativeUsage).length > 0
                  ? { usage: nextCumulativeUsage }
                  : {}),
                turnItems: outcome.result.turnItems,
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

            cumulativeUsage = nextCumulativeUsage;
            cumulativeCommandMessages.push(...filteredMessages);

            const nextPlan = this.deps.approvalFlow.prepareContinuation('y', undefined);
            if (!nextPlan) {
              const approvalFallback = this.#buildApprovalRequiredFromAutoApprove(outcome, nextCumulativeUsage);
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
            inputMode = nextPlan.pendingApprovalContext.inputMode ?? inputMode;

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
            this.deps.inputPlanner.recordSuccess(
              inputMode === 'delta' ? stream : this.deps.conversationStore.getHistory(),
              inputMode === 'delta' ? { kind: inputMode } : { kind: inputMode, previousInput: previousInputForSurge },
            );

            const resultWithUsage: ConversationTerminal = {
              ...outcome.result,
              ...(nextCumulativeUsage && Object.keys(nextCumulativeUsage).length > 0
                ? { usage: nextCumulativeUsage }
                : {}),
            };
            return { kind: 'approval_required', result: resultWithUsage };
          }

          cumulativeUsage = nextCumulativeUsage;
          cumulativeCommandMessages.push(...filteredMessages);

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
          inputMode = nextPlan.pendingApprovalContext.inputMode ?? inputMode;

          continue;
        } catch (error) {
          const maxTransientRetries = getMaxTransientRetries({
            streamMaxRetries: getMethod<[], number | undefined>(this.deps.agentClient, 'getStreamMaxRetries')?.call(
              this.deps.agentClient,
            ),
          });
          const retryStream = lastStream;

          const classified = this.deps.retryClassifier.classify({
            error,
            retryCounts,
            stream: retryStream,
            maxTransientRetries,
          });

          if (classified.kind === 'unrecoverable') {
            throw error;
          }

          const presentation = this.deps.retryEventPresenter.present({
            failure: classified,
            maxTransientRetries,
            source: 'continuation',
            error,
          });

          yield presentation.event;

          this.deps.logger.warn(presentation.logMessage, {
            ...presentation.logFields,
            sessionId: this.deps.sessionId,
            traceId: this.deps.logger.getCorrelationId(),
          });

          if (!this.deps.generationGuard.isCurrent(token)) {
            return { kind: 'stale' };
          }

          const nextRetryCounts = this.deps.recoveryPolicy.nextRetryCounts(retryCounts, classified);
          retryCounts = nextRetryCounts;

          const plan = this.deps.recoveryPolicy.plan({
            failure: classified,
            gen: token,
            stream: retryStream,
            retryCounts,
            freshStartRetriesAllowed: true,
          });

          const recoveryState: RecoveryState = {
            ledgerSnapshot,
            addedUserMessage: false,
            stream: retryStream,
            currentState,
            toolResultCallIds: currentCallIds,
          };

          const recoveryResult = this.deps.recoveryExecutor.apply({
            plan,
            state: recoveryState,
            retryCounts,
          });

          if (recoveryResult.kind === 'terminated') {
            throw error;
          }

          if (recoveryResult.instruction.resumeState) {
            currentState = recoveryResult.instruction.resumeState;
            currentCallIds = [];
            currentResumePreviousResponseId = recoveryResult.instruction.resumePreviousResponseId;
          } else {
            return { kind: 'fresh_start_required', retryCounts };
          }
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
        token: plan.pendingApprovalContext.token,
        inputMode: plan.pendingApprovalContext.inputMode,
        cumulativeUsage: plan.pendingApprovalContext.cumulativeUsage,
        cumulativeCommandMessages: plan.pendingApprovalContext.cumulativeCommandMessages,
        cumulativeTurnItems: plan.pendingApprovalContext.cumulativeTurnItems,
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
      token: abortedContext.token,
      inputMode: abortedContext.inputMode,
      cumulativeUsage: abortedContext.cumulativeUsage,
      cumulativeCommandMessages: abortedContext.cumulativeCommandMessages,
      cumulativeTurnItems: abortedContext.cumulativeTurnItems,
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
