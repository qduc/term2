import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import { buildToolLedgerFromJournalEvents } from '../conversation/journal-to-ledger.js';
import type { NextRunInstruction, RecoveryResult, RecoveryExecutor, RecoveryExecutorInput } from './retry-contracts.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { SessionToolTracker } from '../session/session-tool-tracker.js';
import { projectProviderHistory, ProjectionWarningCode } from '../conversation/conversation-state-projector.js';

const journalSnapshotToLedger = (
  snapshot: import('../logging/conversation-log-events.js').AssistantJournalItemLogEvent[] | undefined,
): SavedToolExecution[] => {
  if (!snapshot || snapshot.length === 0) return [];
  return buildToolLedgerFromJournalEvents(snapshot, new Date().toISOString());
};

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
        this.deps.toolTracker.import(journalSnapshotToLedger(state.journalSnapshot));

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
          const recoveryStates = new Set([state.currentState, state.stream?.state].filter(Boolean));
          for (const runState of recoveryStates) {
            this.deps.toolTracker.recoverApprovedResultsFromState(runState, state.toolResultCallIds);
          }
        }
        if (state.stream) {
          this.deps.providerContinuity.clear();
          this.deps.toolTracker.restoreCompletedEntries(journalSnapshotToLedger(state.journalSnapshot));
          const projected = projectProviderHistory({
            history: this.deps.conversationStore.getHistory(),
            toolLedger: this.deps.toolTracker.export(),
          });
          if (
            projected.warnings.some((warning) => warning.code === ProjectionWarningCode.CompletedToolHistoryInserted)
          ) {
            this.deps.conversationStore.replaceHistory(projected.history);
          }
        } else {
          this.deps.providerContinuity.clear();
          this.deps.toolTracker.restoreCompletedEntries(journalSnapshotToLedger(state.journalSnapshot));
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
          const projected = projectProviderHistory({
            history: this.deps.conversationStore.getHistory(),
            toolLedger: this.deps.toolTracker.export(),
          });
          if (projected.warnings.length > 0) {
            this.deps.conversationStore.replaceHistory(projected.history);
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
