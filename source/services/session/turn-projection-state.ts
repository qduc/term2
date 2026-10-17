import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { type NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { StreamHistorySource } from './session-stream-processor.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { ApprovalDecisionInput } from '../approval/approval-flow-coordinator.js';
import type { AbortedApprovalContext } from '../approval/approval-state.js';
import { RetryRecoveryBudget } from '../retry/retry-recovery-budget.js';

export interface PreparedContinuation {
  toolStartedEvent?: ConversationEvent;
  source: StreamHistorySource;
  inputMode?: 'delta' | 'full_history';
}

export type ContinuationInit =
  | ApprovalDecisionInput
  | {
      kind: 'abort_resolution';
      abortedContext: AbortedApprovalContext;
      userText: string;
      generation: number;
    };

/**
 * Session projection and recovery facts for one whole turn. This object does not
 * encode a waiting position: ApplicationRunLoop retains that position on its async
 * stack, including across manual decisions. Decision handles stay with approval policy;
 * emitted ids and usage reconcile its public stream views.
 */
export class TurnProjectionState {
  readonly token: number;
  source: StreamHistorySource;
  previouslyEmittedIds: Set<string>;
  inputMode: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  retryCounts: RetryCounts;
  lastStream: AgentStream | null;
  /** Shared with the initial attempt that started this logical turn, when one exists. */
  readonly recoveryBudget: RetryRecoveryBudget;

  constructor(token: number, recoveryBudget?: RetryRecoveryBudget) {
    this.token = token;
    this.recoveryBudget = recoveryBudget ?? new RetryRecoveryBudget();
    this.source = 'startStream';
    this.previouslyEmittedIds = new Set();
    this.inputMode = 'delta';
    this.retryCounts = {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    };
    this.lastStream = null;
  }

  /** A recovery may rebuild the attempt; it retains this projection object's identity. */
  resetForAttempt(inputMode: 'delta' | 'full_history'): void {
    this.source = 'startStream';
    this.previouslyEmittedIds = new Set();
    this.inputMode = inputMode;
    this.cumulativeUsage = undefined;
    this.retryCounts = {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    };
    this.lastStream = null;
  }

  /** Bind the pending decision without replacing accumulated projection facts. */
  bindDecision(prepared: PreparedContinuation): void {
    this.source = prepared.source;
    this.inputMode = prepared.inputMode ?? this.inputMode;
  }

  setLastStream(stream: AgentStream | null): void {
    this.lastStream = stream;
  }

  setCumulativeUsage(usage: NormalizedUsage | undefined): void {
    this.cumulativeUsage = usage;
  }

  setRetryCounts(counts: RetryCounts): void {
    this.retryCounts = counts;
  }
}
