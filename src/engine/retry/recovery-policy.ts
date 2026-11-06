import type { ClassifiedFailure, RecoveryContext, RecoveryPlan, RetryCounts } from './retry-contracts.js';

export class DefaultConversationRecoveryPolicy {
  plan(context: RecoveryContext): RecoveryPlan {
    const { failure, stream, freshStartRetriesAllowed } = context;

    // Sessions that forbid fresh starts (subagents) must not replay their task
    // from the beginning. Once a stream exists the retry resumes from durable
    // history instead, so a mid-stream transport drop stays recoverable.
    if (!freshStartRetriesAllowed && !stream && failure.kind === 'transient') {
      return { kind: 'terminate', events: [] };
    }

    switch (failure.kind) {
      case 'service_tier_fallback':
        return { kind: 'retry_fresh', inputMode: 'delta', useStandardServiceTier: true };

      case 'transient': {
        return { kind: 'retry_fresh', inputMode: 'full_history' };
      }

      case 'chain_recovery':
        return { kind: 'retry_fresh', inputMode: 'full_history', disableChainingForAttempt: true };

      case 'transport_downgrade':
        return { kind: 'retry_fresh', inputMode: 'full_history' };

      case 'model_retry': {
        if (stream) {
          return {
            kind: 'replay_turn',
            inputMode: 'full_history',
            rollbackUserMessage: false,
            errorContext: failure.errorContext,
          };
        }
        return {
          kind: 'replay_turn',
          inputMode: 'full_history',
          rollbackUserMessage: true,
        };
      }

      case 'unrecoverable':
        return {
          kind: 'terminate',
          events: [],
        };
    }
  }

  nextRetryCounts(current: RetryCounts, failure: ClassifiedFailure): RetryCounts {
    switch (failure.kind) {
      case 'transient':
        return { ...current, transientRetryCount: failure.attempt };
      case 'chain_recovery':
        return { ...current, transientRetryCount: failure.attempt };
      case 'service_tier_fallback':
        return { ...current, serviceTierFallbackCount: current.serviceTierFallbackCount + 1 };
      case 'transport_downgrade':
        return {
          ...current,
          transientRetryCount: 0,
          transportDowngradeCount: current.transportDowngradeCount + 1,
        };
      case 'model_retry':
        return { ...current, modelRetryCount: current.modelRetryCount + 1 };
      case 'unrecoverable':
        return current;
    }
  }
}
