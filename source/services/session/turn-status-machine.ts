import type { ConversationTerminal } from '../../contracts/conversation.js';

export type SessionStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'continuing';

export type TurnOutcome =
  | { kind: 'response'; terminal: ConversationTerminal }
  | { kind: 'approval_required'; terminal: ConversationTerminal }
  | { kind: 'stale' }
  | { kind: 'failed' };

export type TurnCommand = { kind: 'emit_terminal'; terminal: ConversationTerminal } | { kind: 'none' };

/** Opaque admission lease for the currently active foreground turn. */
export type TurnLease = { readonly generation: number; readonly __turnLease: unique symbol };

/**
 * Transition validator for turn status.
 *
 * Only this class may mutate turn status. Resource cleanup remains with the
 * use case that acquired the resource.
 */
export class TurnStatusMachine {
  private status: SessionStatus = 'idle';
  private nextGeneration = 0;
  private activeLease: TurnLease | undefined;

  get current(): SessionStatus {
    return this.status;
  }

  is(status: SessionStatus): boolean {
    return this.status === status;
  }

  beginTurn(): TurnLease {
    this.#assertTransition('idle', 'streaming');
    this.status = 'streaming';
    this.activeLease = { generation: ++this.nextGeneration } as TurnLease;
    return this.activeLease;
  }

  requestApproval(lease: TurnLease): void {
    if (!this.owns(lease)) return;
    if (this.status !== 'streaming' && this.status !== 'continuing') {
      throw new Error(`Cannot request approval from ${this.status}`);
    }
    this.status = 'awaiting_approval';
  }

  beginContinuation(): TurnLease {
    this.#assertTransition('awaiting_approval', 'continuing');
    this.status = 'continuing';
    return this.activeLease!;
  }

  /**
   * Transitions to idle when the current status is streaming or continuing.
   * When the status is awaiting_approval this is a no-op so the caller can
   * safely call complete() in a finally block without losing the pending
   * approval state.
   */
  complete(lease: TurnLease): void {
    if (!this.owns(lease)) return;
    if (this.status === 'streaming' || this.status === 'continuing') {
      this.status = 'idle';
      this.activeLease = undefined;
    }
  }

  abort(): void {
    this.status = 'idle';
    this.activeLease = undefined;
  }

  completeOutcome(outcome: TurnOutcome, lease: TurnLease): TurnCommand {
    if (!this.owns(lease)) return { kind: 'none' };
    switch (outcome.kind) {
      case 'response':
        this.complete(lease);
        return { kind: 'emit_terminal', terminal: outcome.terminal };
      case 'approval_required':
        this.requestApproval(lease);
        return { kind: 'emit_terminal', terminal: outcome.terminal };
      case 'stale':
        return { kind: 'none' };
      case 'failed':
        this.complete(lease);
        return { kind: 'none' };
    }
  }

  completeContinuationOutcome(outcome: TurnOutcome, lease: TurnLease): TurnCommand {
    if (!this.owns(lease)) return { kind: 'none' };
    if (this.status === 'continuing' || this.status === 'streaming') {
      return this.completeOutcome(outcome, lease);
    }

    switch (outcome.kind) {
      case 'response':
      case 'approval_required':
        return { kind: 'emit_terminal', terminal: outcome.terminal };
      case 'stale':
      case 'failed':
        return { kind: 'none' };
    }
  }

  owns(lease: TurnLease): boolean {
    return lease === this.activeLease;
  }

  #assertTransition(from: SessionStatus, to: SessionStatus): void {
    if (this.status !== from) {
      throw new Error(`Invalid transition: ${this.status} -> ${to}`);
    }
  }
}
