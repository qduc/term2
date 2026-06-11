import type { AgentInputItem } from '@openai/agents';
import type { ConversationEvent } from './conversation-events.js';
import { reconcileHistoryWithToolLedger } from './tool-execution-ledger.js';
import type { NextRunInstruction, RecoveryResult, RecoveryExecutor, RecoveryExecutorInput } from './retry-contracts.js';
import type { ConversationStore } from './conversation-store.js';
import type { ProviderContinuity } from './provider-continuity.js';
import type { SessionToolTracker } from './session-tool-tracker.js';

export type RecoveryExecutorDeps = {
  toolTracker: SessionToolTracker;
  conversationStore: ConversationStore;
  providerContinuity: ProviderContinuity;
};

export class DefaultRecoveryExecutor implements RecoveryExecutor {
  constructor(private deps: RecoveryExecutorDeps) {}

  apply(input: RecoveryExecutorInput): RecoveryResult {
    const { plan, state, retryCounts, maxModelRetries } = input;
    switch (plan.kind) {
      case 'resume_stream': {
        const instruction: NextRunInstruction = {
          skipUserMessage: true,
          retryCounts,
          maxModelRetries,
          resumeState: plan.state,
          resumePreviousResponseId: plan.previousResponseId,
        };
        return { kind: 'run', instruction, events: [] };
      }

      case 'replay_turn': {
        this.deps.providerContinuity.clear();
        this.deps.toolTracker.import(state.ledgerSnapshot);

        if (plan.rollbackUserMessage) {
          this.deps.conversationStore.removeLastUserMessage();
        }

        if (plan.errorContext) {
          this.deps.conversationStore.addErrorContext(plan.errorContext);
        }

        const instruction: NextRunInstruction = {
          skipUserMessage: !plan.rollbackUserMessage,
          retryCounts,
          maxModelRetries,
        };
        return { kind: 'run', instruction, events: [] };
      }

      case 'retry_fresh': {
        if (state.toolResultCallIds) {
          const runState = state.stream?.state ?? state.currentState;
          if (runState) {
            this.deps.toolTracker.recoverApprovedResultsFromState(runState, state.toolResultCallIds);
          }
        }
        if (state.stream) {
          this.deps.providerContinuity.clear();
          this.deps.toolTracker.restoreCompletedEntries(state.ledgerSnapshot);
          const reconciled = reconcileHistoryWithToolLedger(
            this.deps.conversationStore.getHistory(),
            this.deps.toolTracker.export(),
          );
          if (reconciled.addedCompletedPairs > 0) {
            this.deps.conversationStore.replaceHistory(reconciled.history as AgentInputItem[]);
          }
        } else {
          this.deps.providerContinuity.clear();
          this.deps.toolTracker.restoreCompletedEntries(state.ledgerSnapshot);
        }

        const instruction: NextRunInstruction = {
          skipUserMessage: true,
          retryCounts,
          maxModelRetries,
        };
        return {
          kind: 'run',
          instruction,
          ...(plan.useStandardServiceTier ? { useStandardServiceTier: true } : {}),
          events: [],
        };
      }

      case 'terminate': {
        const events: ConversationEvent[] = [];

        if (state.addedUserMessage && !state.stream) {
          this.deps.conversationStore.removeLastUserMessage();
        }

        if (state.stream) {
          this.deps.toolTracker.markOpenCallsAborted('Stream failed');
          const reconciled = reconcileHistoryWithToolLedger(
            this.deps.conversationStore.getHistory(),
            this.deps.toolTracker.export(),
          );
          if (reconciled.addedCompletedPairs > 0 || reconciled.droppedIncompleteCalls > 0) {
            this.deps.conversationStore.replaceHistory(reconciled.history as AgentInputItem[]);
          }
        }

        const recoverySummary = this.deps.toolTracker.getRecoverySummary();
        if (recoverySummary) {
          events.push({
            type: 'tool_recovery',
            recoveredCallIds: recoverySummary.recoveredCallIds,
            droppedCallIds: recoverySummary.droppedCallIds,
            message: recoverySummary.message,
          });
        }

        return { kind: 'terminated', events: [...plan.events, ...events] };
      }
    }
  }
}
