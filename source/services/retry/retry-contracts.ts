import type { ContinuationHandle } from '../../contracts/continuation-handle.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { AssistantJournalItemLogEvent } from '../logging/conversation-log-events.js';

// ── Classification ─────────────────────────────────────────────

export type ClassifiedFailure =
  | { kind: 'transient'; attempt: number; delayMs: number }
  /**
   * Rebuild from full history, charged against the normal bounded
   * transient-retry budget. `cause` distinguishes two different underlying
   * events that share this recovery mechanism but must not share a
   * presentation:
   *  - 'provider_state_rejected': the provider actively rejected conversation
   *    continuity (e.g. `previous_response_not_found`, a missing/orphaned
   *    chained tool result).
   *  - 'connection_interrupted': the connection dropped before a terminal
   *    response event (e.g. WebSocket close code 1006); the provider made no
   *    rejection claim at all.
   */
  | {
      kind: 'chain_recovery';
      attempt: number;
      delayMs: number;
      cause: 'provider_state_rejected' | 'connection_interrupted';
    }
  | { kind: 'service_tier_fallback' }
  | { kind: 'transport_downgrade' }
  | {
      kind: 'model_retry';
      errorContext?: string;
      retryEvent?: import('../conversation/conversation-events.js').ConversationEvent;
    }
  | { kind: 'unrecoverable' };

// ── Recovery Plan ──────────────────────────────────────────────

export type RecoveryPlan =
  | { kind: 'resume_stream'; state: ContinuationHandle; previousResponseId: string | null }
  | { kind: 'replay_turn'; inputMode: 'full_history'; rollbackUserMessage: boolean; errorContext?: string }
  | {
      kind: 'retry_fresh';
      inputMode: 'delta' | 'full_history';
      useStandardServiceTier?: boolean;
      /** Skip previous_response_id and transport history compression on the next attempt. */
      disableChainingForAttempt?: boolean;
    }
  | { kind: 'terminate'; events: ConversationEvent[] };

// ── Retry Counts ───────────────────────────────────────────────

export type RetryCounts = {
  transientRetryCount: number;
  serviceTierFallbackCount: number;
  modelRetryCount: number;
  transportDowngradeCount: number;
};

// ── Classification Context ─────────────────────────────────────

export type ClassificationContext = {
  error: unknown;
  retryCounts: RetryCounts;
  stream: AgentStream | null;
  /** True once a model event has crossed the session stream boundary. */
  hasCommittedOutput?: boolean;
  maxTransientRetries: number;
  maxModelRetries?: number;
};

// ── Recovery Context ───────────────────────────────────────────

export type RecoveryContext = {
  failure: ClassifiedFailure;
  gen: number;
  stream: AgentStream | null;
  retryCounts: RetryCounts;
  maxModelRetries?: number;
  freshStartRetriesAllowed: boolean;
};

// ── Recovery State ─────────────────────────────────────────────

export type RecoveryState = {
  /** Durable assistant-output journal events; replaces the legacy ledger snapshot. */
  journalSnapshot: AssistantJournalItemLogEvent[];
  addedUserMessage: boolean;
  stream: AgentStream | null;
};

// ── Execution Instruction ──────────────────────────────────────

export type NextRunInstruction = {
  skipUserMessage: boolean;
  retryCounts: RetryCounts;
  maxModelRetries?: number;
  resumeState?: ContinuationHandle;
  resumePreviousResponseId?: string | null;
  disableChainingForAttempt?: boolean;
};

// ── Recovery Result ────────────────────────────────────────────

export type RecoveryInstructions = {
  delayMs?: number;
  useStandardServiceTier?: boolean;
  disableChainingForAttempt?: boolean;
};

export type RecoveryResult =
  | ({
      kind: 'run';
      instruction: NextRunInstruction;
      events: ConversationEvent[];
    } & RecoveryInstructions)
  | { kind: 'terminated'; events: ConversationEvent[] };

export type RecoveryExecutorInput = {
  plan: RecoveryPlan;
  state: RecoveryState;
  retryCounts: RetryCounts;
  maxModelRetries?: number;
};

// ── Interfaces ─────────────────────────────────────────────────

export interface RetryClassifier {
  classify(context: ClassificationContext): ClassifiedFailure;
}

export interface ConversationRecoveryPolicy {
  plan(context: RecoveryContext): RecoveryPlan;
}

export interface RecoveryExecutor {
  apply(input: RecoveryExecutorInput): RecoveryResult;
}
