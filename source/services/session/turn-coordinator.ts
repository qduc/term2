import type { ConversationEvent } from '../conversation/conversation-events.js';
import { toTerminalEvent } from '../conversation/conversation-result-builder.js';
import { type UserTurn } from '../../types/user-turn.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import { ContinuationDriver } from './continuation-driver.js';
import { InitialTurnRunner } from './initial-turn-runner.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import { ShellAutoApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import { decideTurnTransition } from './turn-transition.js';
import type { StreamingTurnOutcome, TurnCommand, TurnState } from './turn-transition.js';
import { fromInitialOutcome, fromDriveResult } from './turn-outcome-adapters.js';
import type { InitialTurnRunOptions } from './turn-attempt-factory.js';

export interface TurnCoordinatorDeps {
  statusMachine: TurnStatusMachine;
  initialTurnRunner: InitialTurnRunner;
  continuationDriver: ContinuationDriver;
  approvalFlow: ApprovalFlowCoordinator;
  shellAutoApproval: ShellAutoApprovalResolver;
}

export class TurnCoordinator {
  constructor(private readonly deps: TurnCoordinatorDeps) {}

  async *start(
    input: string | UserTurn,
    options: {
      skipUserMessage?: boolean;
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
      const turnOutcome = yield* this.#runInitialTurn(input, {
        skipUserMessage: options.skipUserMessage,
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

      const driveResult = yield* this.deps.continuationDriver.drive({
        kind: 'approval_decision',
        answer,
        rejectionReason,
        generation: gen,
      });
      const turnOutcome = fromDriveResult(driveResult);
      let transition = decideTurnTransition('continuing', turnOutcome);

      if (transition.command.kind === 're_drive') {
        this.deps.statusMachine.complete();
        this.deps.statusMachine.beginTurn();

        const reDriveOutcome = yield* this.#runInitialTurn(
          { text: '' },
          {
            ...transition.command.options,
            token: gen,
          },
        );
        transition = decideTurnTransition('streaming', reDriveOutcome);
      }

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

  /**
   * Run the initial turn runner and handle intermediate outcomes
   * (abort_resolution_required, auto_approval_required) by delegating
   * to the ContinuationDriver. Returns a canonical TurnOutcome suitable
   * for the transition core.
   */
  async *#runInitialTurn(
    input: string | UserTurn,
    options: InitialTurnRunOptions,
  ): AsyncGenerator<ConversationEvent, StreamingTurnOutcome, void> {
    let currentInput = input;
    let currentOptions = options;

    while (true) {
      const it = this.deps.initialTurnRunner.run(currentInput, currentOptions);
      let res = await it.next();
      while (!res.done) {
        yield res.value;
        res = await it.next();
      }
      const initialOutcome = res.value;

      let driveResult;
      let generation: number;
      if (initialOutcome.kind === 'abort_resolution_required') {
        generation = initialOutcome.generation;
        driveResult = yield* this.deps.continuationDriver.drive(
          {
            kind: 'abort_resolution',
            abortedContext: initialOutcome.abortedContext,
            userText: initialOutcome.userText,
            generation,
          },
          new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
        );
      } else if (initialOutcome.kind === 'auto_approval_required') {
        generation = initialOutcome.generation;
        driveResult = yield* this.deps.continuationDriver.drive(
          {
            kind: 'approval_decision',
            answer: 'y',
            generation,
          },
          new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
        );
      } else {
        return fromInitialOutcome(initialOutcome);
      }

      const turnOutcome = fromDriveResult(driveResult);
      if (turnOutcome.kind !== 'fresh_start_required') {
        return turnOutcome;
      }

      const transition = decideTurnTransition('continuing', turnOutcome);
      if (transition.command.kind !== 're_drive') {
        throw new Error(`Expected re_drive command, received ${transition.command.kind}`);
      }
      currentInput = { text: '' };
      currentOptions = {
        ...transition.command.options,
        token: generation,
      };
    }
  }

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
