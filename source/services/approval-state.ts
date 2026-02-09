export type PendingApprovalContext = {
  state: unknown;
  interruption: unknown;
  emittedCommandIds: Set<string>;
  toolCallArgumentsById: Map<string, unknown>;
  removeInterceptor?: () => void;
};

export type AbortedApprovalContext = {
  state: unknown;
  interruption: unknown;
  emittedCommandIds: Set<string>;
  toolCallArgumentsById: Map<string, unknown>;
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
