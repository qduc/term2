import type { ContinuationHandle } from '../../contracts/continuation-handle.js';
import { type GenerationToken } from '../generation-guard.js';
import { type NormalizedUsage } from '../../utils/ai/token-usage.js';
import { type CommandMessage } from '../../tools/types.js';
import { type PersistedAssistantTurnItem } from '../conversation/conversation-persistence-types.js';
import { PARENT_TOOL_OWNER, type ToolOwner } from './tool-owner.js';

export type ApprovalBatchDecision = 'approved' | 'rejected';

export type PendingApprovalContext = {
  state: ContinuationHandle;
  interruption: unknown;
  interruptions?: unknown[];
  decisionsByCallId?: Map<string, ApprovalBatchDecision>;
  promptedCallId?: string;
  emittedCommandIds: Set<string>;
  toolCallArgumentsById: Map<string, unknown>;
  owner: ToolOwner;
  token?: GenerationToken;
  inputMode?: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  cumulativeCommandMessages?: CommandMessage[];
  cumulativeTurnItems?: PersistedAssistantTurnItem[];
};

export type AbortedApprovalContext = {
  state: ContinuationHandle;
  interruption: unknown;
  interruptions?: unknown[];
  decisionsByCallId?: Map<string, ApprovalBatchDecision>;
  promptedCallId?: string;
  emittedCommandIds: Set<string>;
  toolCallArgumentsById: Map<string, unknown>;
  owner: ToolOwner;
  token?: GenerationToken;
  inputMode?: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  cumulativeCommandMessages?: CommandMessage[];
  cumulativeTurnItems?: PersistedAssistantTurnItem[];
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
      emittedCommandIds: this.pending.emittedCommandIds,
      toolCallArgumentsById: this.pending.toolCallArgumentsById,
      owner: this.pending.owner,
      token: this.pending.token,
      inputMode: this.pending.inputMode,
      cumulativeUsage: this.pending.cumulativeUsage,
      cumulativeCommandMessages: this.pending.cumulativeCommandMessages,
      cumulativeTurnItems: this.pending.cumulativeTurnItems,
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
