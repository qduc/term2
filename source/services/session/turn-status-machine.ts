import type { ConversationTerminal } from '../../contracts/conversation.js';

export type SessionStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'continuing';

export type TurnOutcome =
  | { kind: 'response'; terminal: ConversationTerminal }
  | { kind: 'approval_required'; terminal: ConversationTerminal }
  | { kind: 'stale' }
  | { kind: 'failed' };

export type TurnCommand = { kind: 'emit_terminal'; terminal: ConversationTerminal } | { kind: 'none' };

/**
 * Transition validator for turn status.
 *
 * Only this class may mutate turn status. Resource cleanup remains with the
 * use case that acquired the resource.
 */
export class TurnStatusMachine {
  private status: SessionStatus = 'idle';

  get current(): SessionStatus {
    return this.status;
  }

  is(status: SessionStatus): boolean {
    return this.status === status;
  }

  beginTurn(): void {
    this.#assertTransition('idle', 'streaming');
    this.status = 'streaming';
  }

  requestApproval(): void {
    if (this.status !== 'streaming' && this.status !== 'continuing') {
      throw new Error(`Cannot request approval from ${this.status}`);
    }
    this.status = 'awaiting_approval';
  }

  beginContinuation(): void {
    this.#assertTransition('awaiting_approval', 'continuing');
    this.status = 'continuing';
  }

  /**
   * Transitions to idle when the current status is streaming or continuing.
   * When the status is awaiting_approval this is a no-op so the caller can
   * safely call complete() in a finally block without losing the pending
   * approval state.
   */
  complete(): void {
    if (this.status === 'streaming' || this.status === 'continuing') {
      this.status = 'idle';
    }
  }

  abort(): void {
    this.status = 'idle';
  }

  completeOutcome(outcome: TurnOutcome): TurnCommand {
    switch (outcome.kind) {
      case 'response':
        this.complete();
        return { kind: 'emit_terminal', terminal: outcome.terminal };
      case 'approval_required':
        this.requestApproval();
        return { kind: 'emit_terminal', terminal: outcome.terminal };
      case 'stale':
        return { kind: 'none' };
      case 'failed':
        this.complete();
        return { kind: 'none' };
    }
  }

  completeContinuationOutcome(outcome: TurnOutcome): TurnCommand {
    if (this.status === 'continuing' || this.status === 'streaming') {
      return this.completeOutcome(outcome);
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

  #assertTransition(from: SessionStatus, to: SessionStatus): void {
    if (this.status !== from) {
      throw new Error(`Invalid transition: ${this.status} -> ${to}`);
    }
  }
}
