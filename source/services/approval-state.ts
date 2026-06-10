import { type RunState } from '@openai/agents';
import { type GenerationToken } from './generation-guard.js';

export type PendingApprovalContext = {
  state: RunState<any, any>;
  interruption: unknown;
  emittedCommandIds: Set<string>;
  toolCallArgumentsById: Map<string, unknown>;
  removeInterceptor?: () => void;
  /** Nested agent-tool approvals must resume through SDK state, not parent tool interceptors. */
  nestedSubagent?: boolean;
  token?: GenerationToken;
};

export type AbortedApprovalContext = {
  state: RunState<any, any>;
  interruption: unknown;
  emittedCommandIds: Set<string>;
  toolCallArgumentsById: Map<string, unknown>;
  removeInterceptor?: () => void;
  nestedSubagent?: boolean;
  token?: GenerationToken;
};

export class ApprovalState {
  private pending: PendingApprovalContext | null = null;
  private aborted: AbortedApprovalContext | null = null;

  getPending(): PendingApprovalContext | null {
    return this.pending;
  }

  setPending(context: PendingApprovalContext): void {
    this.pending = context;
  }

  clearPending(): void {
    this.pending = null;
  }

  setPendingRemoveInterceptor(removeInterceptor: (() => void) | null): void {
    if (!this.pending) {
      return;
    }

    this.pending = {
      ...this.pending,
      ...(removeInterceptor ? { removeInterceptor } : {}),
    };
  }

  abortPending(): boolean {
    if (!this.pending) {
      return false;
    }

    this.aborted = {
      state: this.pending.state,
      interruption: this.pending.interruption,
      emittedCommandIds: this.pending.emittedCommandIds,
      toolCallArgumentsById: this.pending.toolCallArgumentsById,
      removeInterceptor: this.pending.removeInterceptor,
      nestedSubagent: this.pending.nestedSubagent,
      token: this.pending.token,
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
