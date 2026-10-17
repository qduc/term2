import type { ContinuationHandle } from '../../contracts/continuation-handle.js';
import { type GenerationToken } from '../generation-guard.js';
import { PARENT_TOOL_OWNER, type ToolOwner } from './tool-owner.js';

export type ApprovalBatchDecision = 'approved' | 'rejected';

export type PendingApprovalContext = {
  state: ContinuationHandle;
  interruption: unknown;
  interruptions?: unknown[];
  decisionsByCallId?: Map<string, ApprovalBatchDecision>;
  promptedCallId?: string;
  owner: ToolOwner;
  token?: GenerationToken;
  inputMode?: 'delta' | 'full_history';
};

export type AbortedApprovalContext = {
  state: ContinuationHandle;
  interruption: unknown;
  interruptions?: unknown[];
  decisionsByCallId?: Map<string, ApprovalBatchDecision>;
  promptedCallId?: string;
  owner: ToolOwner;
  token?: GenerationToken;
  inputMode?: 'delta' | 'full_history';
};

export class ApprovalState {
  private pending: PendingApprovalContext | null = null;
  private aborted: AbortedApprovalContext | null = null;

  getPending(): PendingApprovalContext | null {
    return this.pending;
  }

  setPending(context: Omit<PendingApprovalContext, 'owner'> & { owner?: ToolOwner }): void {
    context.owner ??= PARENT_TOOL_OWNER;
    this.pending = context as PendingApprovalContext;
  }

  clearPending(): void {
    this.pending = null;
  }

  abortPending(): boolean {
    if (!this.pending) {
      return false;
    }

    this.aborted = {
      state: this.pending.state,
      interruption: this.pending.interruption,
      interruptions: this.pending.interruptions,
      decisionsByCallId: this.pending.decisionsByCallId,
      promptedCallId: this.pending.promptedCallId,
      owner: this.pending.owner,
      token: this.pending.token,
      inputMode: this.pending.inputMode,
    };
    this.pending = null;
    return true;
  }

  consumeAborted(): AbortedApprovalContext | null {
    const aborted = this.aborted;
    this.aborted = null;
    return aborted;
  }
}
