import type { RunState } from '@openai/agents';
import type { AgentStream } from './agent-stream.js';
import type { ConversationEvent } from './conversation-events.js';
import type { SavedToolExecution } from './tool-execution-ledger.js';

// ── Classification ─────────────────────────────────────────────

export type ClassifiedFailure =
  | { kind: 'transient'; attempt: number; delayMs: number }
  | { kind: 'service_tier_fallback' }
  | { kind: 'transport_downgrade' }
  | { kind: 'model_retry'; errorContext?: string; retryEvent?: import('./conversation-events.js').ConversationEvent }
  | { kind: 'unrecoverable' };

// ── Recovery Plan ──────────────────────────────────────────────

export type RecoveryPlan =
  | { kind: 'resume_stream'; state: RunState<any, any>; previousResponseId: string | null }
  | { kind: 'replay_turn'; inputMode: 'full_history'; rollbackUserMessage: boolean; errorContext?: string }
  | { kind: 'retry_fresh'; inputMode: 'delta' | 'full_history'; useStandardServiceTier?: boolean }
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
  ledgerSnapshot: SavedToolExecution[];
  addedUserMessage: boolean;
  stream: AgentStream | null;
};

// ── Execution Instruction ──────────────────────────────────────

export type NextRunInstruction = {
  skipUserMessage: boolean;
  retryCounts: RetryCounts;
  maxModelRetries?: number;
  resumeState?: RunState<any, any>;
  resumePreviousResponseId?: string | null;
};

// ── Recovery Result ────────────────────────────────────────────

export type RecoveryResult =
  | {
      kind: 'run';
      instruction: NextRunInstruction;
      delayMs?: number;
      useStandardServiceTier?: boolean;
      events: ConversationEvent[];
    }
  | { kind: 'terminated'; events: ConversationEvent[] };

// ── Interfaces ─────────────────────────────────────────────────

export interface RetryClassifier {
  classify(context: ClassificationContext): ClassifiedFailure;
}

export interface ConversationRecoveryPolicy {
  plan(context: RecoveryContext): RecoveryPlan;
}

export interface RecoveryExecutor {
  apply(plan: RecoveryPlan, state: RecoveryState): RecoveryResult;
}
