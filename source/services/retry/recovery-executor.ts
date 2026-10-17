import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { NextRunInstruction, RecoveryResult, RecoveryExecutor, RecoveryExecutorInput } from './retry-contracts.js';
import type { ConversationRecord } from '../conversation/conversation-record.js';
import type { ProviderContinuity } from '../provider-continuity.js';

export type RecoveryExecutorDeps = {
  record: ConversationRecord;
  providerContinuity: ProviderContinuity;
};

/** Applies policy-selected retry settings; Record owns acceptance and reconstruction. */
export class DefaultRecoveryExecutor implements RecoveryExecutor {
  constructor(private deps: RecoveryExecutorDeps) {}

  apply(input: RecoveryExecutorInput): RecoveryResult {
    const { plan, state, retryCounts, maxModelRetries } = input;
    this.deps.providerContinuity.clear();
    const recoverySummary = this.deps.record.recover(plan, state);
    switch (plan.kind) {
      case 'replay_turn': {
        const instruction: NextRunInstruction = {
          skipUserMessage: !plan.rollbackUserMessage,
          retryCounts,
          maxModelRetries,
        };
        return { kind: 'run', instruction, events: [] };
      }
      case 'retry_fresh': {
        const instruction: NextRunInstruction = {
          skipUserMessage: true,
          retryCounts,
          maxModelRetries,
          ...(plan.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
        };
        return {
          kind: 'run',
          instruction,
          ...(plan.useStandardServiceTier ? { useStandardServiceTier: true } : {}),
          ...(plan.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
          events: [],
        };
      }
      case 'terminate': {
        const events: ConversationEvent[] = recoverySummary
          ? [
              {
                type: 'tool_recovery',
                recoveredCallIds: recoverySummary.recoveredCallIds,
                droppedCallIds: recoverySummary.droppedCallIds,
                message: recoverySummary.message,
              },
            ]
          : [];
        return { kind: 'terminated', events: [...plan.events, ...events] };
      }
    }
  }
}
