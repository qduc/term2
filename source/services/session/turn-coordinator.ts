import type { ConversationEvent } from '../conversation/conversation-events.js';
import { toTerminalEvent } from '../conversation/conversation-result-builder.js';
import { type UserTurn } from '../../types/user-turn.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import { decideTurnTransition, type TurnCommand, type TurnState } from './turn-transition.js';
import type { TurnExecutor } from './turn-executor.js';

export interface TurnCoordinatorDeps {
  statusMachine: TurnStatusMachine;
  turnExecutor: TurnExecutor;
  approvalFlow: ApprovalFlowCoordinator;
}

export class TurnCoordinator {
  constructor(private readonly deps: TurnCoordinatorDeps) {}

  async *start(
    input: string | UserTurn,
    options: {
      skipUserMessage?: boolean;
      replayFromHistory?: boolean;
      retries?: any;
      maxModelRetries?: number;
      signal?: AbortSignal;
      resumeState?: any;
      resumePreviousResponseId?: string | null;
      bypassInputSurgeGuard?: boolean;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    if (!this.deps.statusMachine.is('idle')) {
      throw new Error('Another foreground turn is already active.');
    }
    const abortedStatus = this.deps.approvalFlow.getAbortedStatus();
    if (abortedStatus.kind === 'stale') {
      return;
    }
    const abortedContext = abortedStatus.kind === 'current' ? abortedStatus.context : null;

    this.deps.statusMachine.beginTurn();
    let finalState: TurnState = 'streaming';
    let processed = false;
    try {
      const turnOutcome = yield* this.deps.turnExecutor.executeInitial(input, {
        skipUserMessage: options.skipUserMessage,
        replayFromHistory: options.replayFromHistory,
        resumeState: options.resumeState,
        resumePreviousResponseId: options.resumePreviousResponseId,
        abortedContext,
        retries: options.retries,
        maxModelRetries: options.maxModelRetries,
        signal: options.signal,
        bypassInputSurgeGuard: options.bypassInputSurgeGuard,
      });
      processed = true;

      // Use transition core to determine next state and command
      const transition = decideTurnTransition('streaming', turnOutcome);
      finalState = transition.next;

      if (transition.command.kind === 'emit_terminal') {
        yield toTerminalEvent(transition.command.terminal);
      }
      // 'none' command: no action needed (handled in finally)
    } finally {
      if (!processed) {
        // Error during initial run — reset status to idle
        this.deps.statusMachine.complete();
      } else if (finalState === 'awaiting_approval') {
        this.deps.statusMachine.requestApproval();
      } else if (finalState === 'idle') {
        this.deps.statusMachine.complete();
      }
      // 'streaming' (stale) leaves status untouched — same as current behavior
    }
  }

  async *continueAfterApproval({
    answer,
    rejectionReason,
  }: {
    answer: string;
    rejectionReason?: string;
  }): AsyncIterable<ConversationEvent> {
    if (!this.deps.statusMachine.is('awaiting_approval')) {
      throw new Error('No pending approval to continue.');
    }
    this.deps.statusMachine.beginContinuation();
    let finalState: TurnState = 'continuing';
    let processed = false;
    try {
      const pending = this.deps.approvalFlow.getPending();
      const gen = pending?.token ?? 0;

      const turnOutcome = yield* this.deps.turnExecutor.executeContinuation({
        answer,
        rejectionReason,
        generation: gen,
      });
      const transition = decideTurnTransition('continuing', turnOutcome);

      finalState = transition.next;
      processed = true;
      yield* this.#executeTerminalCommand(transition.command);
    } finally {
      if (!processed) {
        // Error during continuation drive — reset status to idle
        this.deps.statusMachine.complete();
      } else if (this.deps.statusMachine.is('continuing') || this.deps.statusMachine.is('streaming')) {
        // Only update status machine if external actions (e.g. abort during a
        // stale drive) haven't already changed the state.
        if (finalState === 'awaiting_approval') {
          this.deps.statusMachine.requestApproval();
        } else if (finalState === 'idle') {
          this.deps.statusMachine.complete();
        }
        // An unchanged active state means the result was stale; leave it alone.
      }
      // If an external action already changed the status, do nothing
    }
  }

  abort(): void {
    this.deps.approvalFlow.abort();
    this.deps.statusMachine.abort();
  }

  // ── Private helpers ──────────────────────────────────────────

  async *#executeTerminalCommand(command: TurnCommand): AsyncGenerator<ConversationEvent, void, void> {
    if (command.kind === 'emit_terminal') {
      yield toTerminalEvent(command.terminal);
      return;
    }
    if (command.kind === 're_drive') {
      throw new Error('re_drive must be executed before terminal command dispatch');
    }
  }
}
