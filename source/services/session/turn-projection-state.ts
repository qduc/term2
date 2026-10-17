import type { ContinuationHandle } from '../../contracts/continuation-handle.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { type NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { StreamHistorySource } from './session-stream-processor.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { AssistantJournalItemLogEvent } from '../logging/conversation-log-events.js';
import type { AbortedApprovalContext } from '../approval/approval-state.js';
import { RetryRecoveryBudget } from '../retry/retry-recovery-budget.js';

export interface PreparedContinuation {
  state: ContinuationHandle;
  interruption: unknown;
  toolCallArgumentsById: Map<string, unknown>;
  toolStartedEvent?: ConversationEvent;
  source: StreamHistorySource;
  inputMode?: 'delta' | 'full_history';
}

export type ContinuationInit =
  | {
      kind: 'approval_decision';
      answer: string;
      rejectionReason?: string;
      generation: number;
      /**
       * End the segment once this decision's tool result is recorded, instead
       * of making another model call. Cancelling an `ask_user` prompt sets it.
       */
      stopAfterApprovalResolution?: boolean;
    }
  | {
      kind: 'abort_resolution';
      abortedContext: AbortedApprovalContext;
      userText: string;
      generation: number;
    };

/**
 * Session projection and recovery facts for one whole turn. This object does not
 * encode a waiting position: ApplicationRunLoop retains that position on its async
 * stack, including across manual decisions. The handle addresses that task;
 * emitted ids, usage and journal snapshots reconcile its public stream views.
 */
export class TurnProjectionState {
  readonly token: number;
  currentState: ContinuationHandle;
  currentCallIds: string[];
  source: StreamHistorySource;
  previouslyEmittedIds: Set<string>;
  journalSnapshot: AssistantJournalItemLogEvent[];
  inputMode: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  retryCounts: RetryCounts;
  lastStream: AgentStream | null;
  currentResumePreviousResponseId: string | null | undefined;
  /** Shared with the initial attempt that started this logical turn, when one exists. */
  readonly recoveryBudget: RetryRecoveryBudget;

  constructor(token: number, recoveryBudget?: RetryRecoveryBudget) {
    this.token = token;
    this.recoveryBudget = recoveryBudget ?? new RetryRecoveryBudget();
    this.currentState = { kind: 'continuation' };
    this.currentCallIds = [];
    this.source = 'startStream';
    this.previouslyEmittedIds = new Set();
    this.journalSnapshot = [];
    this.inputMode = 'delta';
    this.retryCounts = {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    };
    this.lastStream = null;
    this.currentResumePreviousResponseId = undefined;
  }

  /** A recovery may rebuild the attempt; it retains this projection object's identity. */
  resetForAttempt(inputMode: 'delta' | 'full_history'): void {
    this.currentState = { kind: 'continuation' };
    this.currentCallIds = [];
    this.source = 'startStream';
    this.previouslyEmittedIds = new Set();
    this.journalSnapshot = [];
    this.inputMode = inputMode;
    this.cumulativeUsage = undefined;
    this.retryCounts = {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    };
    this.lastStream = null;
    this.currentResumePreviousResponseId = undefined;
  }

  /** Bind the pending decision without replacing accumulated projection facts. */
  bindDecision(prepared: PreparedContinuation, currentCallIds: string[]): void {
    this.currentState = prepared.state;
    this.currentCallIds = currentCallIds;
    this.source = prepared.source;
    this.inputMode = prepared.inputMode ?? this.inputMode;
  }

  advanceFromPlan(
    nextState: ContinuationHandle,
    nextInputMode: 'delta' | 'full_history' | undefined,
    journalSnapshot: AssistantJournalItemLogEvent[],
    currentCallIds: string[],
  ): void {
    this.currentState = nextState;
    this.currentCallIds = currentCallIds;
    this.source = 'continueRunStream';
    this.journalSnapshot = journalSnapshot;
    this.inputMode = nextInputMode ?? this.inputMode;
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

  setResumePreviousResponseId(id: string | null | undefined): void {
    this.currentResumePreviousResponseId = id;
  }

  setJournalSnapshot(snapshot: AssistantJournalItemLogEvent[]): void {
    this.journalSnapshot = snapshot;
  }
}
