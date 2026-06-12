import type { RunState } from '@openai/agents';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { BuildResultOutcome } from '../conversation/conversation-result-builder.js';
import { buildConversationResult } from '../conversation/conversation-result-builder.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { AgentStream } from '../agent-stream.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { SessionStreamProcessor } from './session-stream-processor.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { TurnAttempt } from './turn-attempt.js';
import type { TurnItemAccumulator } from './turn-item-accumulator.js';

export type InitialStreamCycleOptions = {
  resumeState?: RunState<any, any>;
  resumePreviousResponseId?: string | null;
};

export type InitialStreamCycleResult = { kind: 'completed'; outcome: BuildResultOutcome } | { kind: 'stale' };

export type InitialStreamCycleDeps = {
  agentClient: ConversationAgentClient;
  approvalFlow: ApprovalFlowCoordinator;
  conversationStore: ConversationStore;
  inputPlanner: SessionInputPlanner;
  logger: ILoggingService;
  providerContinuity: ProviderContinuity;
  sessionId: string;
  shellAutoApproval: ShellAutoApprovalResolver;
  streamProcessor: SessionStreamProcessor;
  toolTracker: SessionToolTracker;
  turnAccumulator: TurnItemAccumulator;
};

export class InitialStreamCycle {
  constructor(private readonly deps: InitialStreamCycleDeps) {}

  async *execute(
    attempt: TurnAttempt,
    options: InitialStreamCycleOptions,
  ): AsyncGenerator<ConversationEvent, InitialStreamCycleResult, void> {
    const stream = await this.#startStream(attempt, options);
    attempt.attachStream(stream);

    const accumulated = yield* this.deps.streamProcessor.process(stream, {
      gen: attempt.token,
      source: 'startStream',
      preserveExistingToolArgs: false,
    });

    const finalized = this.deps.streamProcessor.finalize(stream, attempt.token, attempt.inputMode!, 'startStream');
    if (finalized.kind === 'stale') {
      return { kind: 'stale' };
    }

    const outcome = await buildConversationResult(
      {
        result: stream,
        finalOutputOverride: accumulated.finalOutput || undefined,
        reasoningOutputOverride: accumulated.reasoningOutput || undefined,
        emittedCommandIds: accumulated.emittedCommandIds,
        usage: accumulated.latestUsage,
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

    this.deps.inputPlanner.recordSuccess(
      attempt.inputMode === 'delta' ? attempt.streamInput! : this.deps.conversationStore.getHistory(),
      attempt.inputMode === 'delta'
        ? { kind: attempt.inputMode }
        : { kind: attempt.inputMode!, previousInput: attempt.streamInput! },
    );

    return { kind: 'completed', outcome };
  }

  async #startStream(attempt: TurnAttempt, options: InitialStreamCycleOptions): Promise<AgentStream> {
    if (options.resumeState && typeof this.deps.agentClient.continueRunStream === 'function') {
      return (await this.deps.agentClient.continueRunStream(options.resumeState, {
        previousResponseId: options.resumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
        sessionId: this.deps.sessionId,
      })) as AgentStream;
    }

    return (await this.deps.agentClient.startStream(attempt.streamInput!, {
      previousResponseId: attempt.inputMode === 'delta' ? this.deps.providerContinuity.previousResponseId : null,
      sessionId: this.deps.sessionId,
    })) as AgentStream;
  }
}
