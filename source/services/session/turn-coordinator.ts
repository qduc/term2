import type { ConversationEvent } from '../conversation/conversation-events.js';
import { toTerminalEvent } from '../conversation/conversation-result-builder.js';
import { type UserTurn } from '../../types/user-turn.js';
import { TurnStatusMachine, type TurnCommand } from './turn-status-machine.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { TurnWorkflow } from './turn-workflow.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { InitialTurnRunOptions } from './turn-attempt-factory.js';

export type TurnStartOptions = Pick<
  InitialTurnRunOptions,
  | 'skipUserMessage'
  | 'replayFromHistory'
  | 'retries'
  | 'maxModelRetries'
  | 'signal'
  | 'resumeState'
  | 'resumePreviousResponseId'
  | 'bypassInputSurgeGuard'
>;

export interface TurnCoordinatorDeps {
  statusMachine: TurnStatusMachine;
  turnWorkflow: TurnWorkflow;
  approvalFlow: ApprovalFlowCoordinator;
  providerContinuity: ProviderContinuity;
}

export class TurnCoordinator {
  constructor(private readonly deps: TurnCoordinatorDeps) {}

  async *start(input: string | UserTurn, options: TurnStartOptions = {}): AsyncIterable<ConversationEvent> {
    if (!this.deps.statusMachine.is('idle')) {
      throw new Error('Another foreground turn is already active.');
    }
    // Consume any approval aborted by Esc before admitting a new foreground
    // turn. The follow-up user message must be sent as a normal new turn, not
    // as a rejection reason used to continue the abandoned SDK run.
    this.deps.approvalFlow.getAbortedStatus();

    this.deps.statusMachine.beginTurn();
    let processed = false;
    try {
      const turnOutcome = yield* this.deps.turnWorkflow.executeInitial(input, options);
      processed = true;

      yield* this.#executeTerminalCommand(this.deps.statusMachine.completeOutcome(turnOutcome));
    } finally {
      if (!processed) {
        // Error during initial run — reset status to idle
        this.deps.statusMachine.complete();
      }
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
    let processed = false;
    try {
      const turnOutcome = yield* this.deps.turnWorkflow.executeContinuation(
        this.deps.approvalFlow.buildApprovalDecision(answer, rejectionReason),
      );
      processed = true;
      yield* this.#executeTerminalCommand(this.deps.statusMachine.completeContinuationOutcome(turnOutcome));
    } finally {
      if (!processed) {
        // Error during continuation drive — reset status to idle
        this.deps.statusMachine.complete();
      }
    }
  }

  abort(): void {
    this.deps.approvalFlow.abort();
    this.deps.statusMachine.abort();
    this.deps.providerContinuity.clear();
  }

  // ── Private helpers ──────────────────────────────────────────

  async *#executeTerminalCommand(command: TurnCommand): AsyncGenerator<ConversationEvent, void, void> {
    if (command.kind === 'emit_terminal') {
      yield toTerminalEvent(command.terminal);
    }
  }
}
