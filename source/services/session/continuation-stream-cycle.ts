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
import type { SessionStreamProcessor } from './session-stream-processor.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { CommandMessage } from '../../tools/types.js';
import { type NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { PersistedAssistantTurnItem } from '../conversation/conversation-persistence-types.js';
import { extractCommandMessages } from '../../utils/streaming/extract-command-messages.js';
import type { ContinuationState } from './continuation-state.js';

export type ContinuationStreamCycleDeps = {
  agentClient: ConversationAgentClient;
  streamProcessor: SessionStreamProcessor;
  conversationStore: ConversationStore;
  turnAccumulator: TurnItemAccumulator;
  toolTracker: SessionToolTracker;
  approvalFlow: ApprovalFlowCoordinator;
  shellAutoApproval: ShellAutoApprovalResolver;
  logger: ILoggingService;
  sessionId: string;
  providerContinuity: ProviderContinuity;
};

export type ContinuationStreamCycleResult =
  | { kind: 'stale' }
  | {
      kind: 'completed';
      outcome: BuildResultOutcome;
      nextCumulativeMessages: CommandMessage[];
      nextCumulativeUsage?: NormalizedUsage;
      nextCumulativeTurnItems: PersistedAssistantTurnItem[];
      mergedEmittedIds: Set<string>;
    };

export class ContinuationStreamCycle {
  constructor(private readonly deps: ContinuationStreamCycleDeps) {}

  async *execute(state: ContinuationState): AsyncGenerator<ConversationEvent, ContinuationStreamCycleResult, void> {
    const stream = (await this.deps.agentClient.continueRunStream(state.currentState, {
      previousResponseId: state.currentResumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
      sessionId: this.deps.sessionId,
      toolResultCallIds: state.currentCallIds,
    })) as AgentStream;
    state.setLastStream(stream);

    const allEmittedIds = new Set([...state.previouslyEmittedIds]);

    const acc = yield* this.deps.streamProcessor.process(stream, {
      gen: state.token,
      source: state.source,
      preserveExistingToolArgs: true,
      previouslyEmittedCommandIds: allEmittedIds,
    });

    const finalizeResult = this.deps.streamProcessor.finalize(stream, state.token, state.inputMode, state.source);
    if (finalizeResult.kind === 'stale') {
      return { kind: 'stale' };
    }

    const mergedEmittedIds = new Set([...allEmittedIds, ...acc.emittedCommandIds]);

    const streamMessages = extractCommandMessages(stream.newItems || stream.history || []);
    const filteredMessages = streamMessages.filter((msg) => !state.previouslyEmittedIds.has(msg.id));
    const nextCumulativeMessages = [...state.cumulativeCommandMessages, ...filteredMessages];
    const nextCumulativeUsage = acc.latestUsage ?? state.cumulativeUsage;
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
        token: state.token,
        inputMode: state.inputMode,
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

    return {
      kind: 'completed',
      outcome,
      nextCumulativeMessages,
      nextCumulativeUsage,
      nextCumulativeTurnItems,
      mergedEmittedIds,
    };
  }
}
