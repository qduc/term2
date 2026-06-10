import type { ConversationEvent } from './conversation-events.js';
import { toTerminalEvent } from './conversation-result-builder.js';
import { type UserTurn } from '../types/user-turn.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import { ContinuationDriver } from './continuation-driver.js';
import { InitialTurnRunner, type InitialTurnOutcome } from './initial-turn-runner.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { type PendingApprovalContext } from './approval-state.js';

export type SessionStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'continuing';

export class TurnState {
  statusMachine = new TurnStatusMachine();
  currentGeneration = 0;
  pendingModeNotice: string | null = null;
  previousResponseId: string | null = null;
  transportDowngradeOccurred = false;
  pendingApproval: PendingApprovalContext | null = null;
}

export interface TurnCoordinatorDeps {
  statusMachine: TurnStatusMachine;
  initialTurnRunner: InitialTurnRunner;
  continuationDriver: ContinuationDriver;
  approvalFlow: ApprovalFlowCoordinator;
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
    let runnerOutcome: InitialTurnOutcome | undefined;
    try {
      const it = this.deps.initialTurnRunner.run(input, {
        skipUserMessage: options.skipUserMessage,
        resumeState: options.resumeState,
        resumePreviousResponseId: options.resumePreviousResponseId,
        abortedContext,
        retries: options.retries,
        maxModelRetries: options.maxModelRetries,
        signal: options.signal,
      });

      let res = await it.next();
      while (!res.done) {
        yield res.value;
        res = await it.next();
      }
      runnerOutcome = res.value;
      if (
        runnerOutcome &&
        (runnerOutcome.kind === 'response' ||
          runnerOutcome.kind === 'approval_required' ||
          runnerOutcome.kind === 'stale')
      ) {
        if (runnerOutcome.terminal) {
          yield toTerminalEvent(runnerOutcome.terminal);
        }
      }
    } finally {
      if (runnerOutcome && runnerOutcome.kind === 'stale') {
        // stale leaves status untouched
      } else if (runnerOutcome && runnerOutcome.kind === 'approval_required') {
        this.deps.statusMachine.requestApproval();
      } else {
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
    let runnerCalled = false;
    let runnerOutcome: InitialTurnOutcome | undefined;
    try {
      const pending = this.deps.approvalFlow.getPending();
      const gen = pending?.token ?? 0;

      const driveResult = yield* this.deps.continuationDriver.drive({
        kind: 'approval_decision',
        answer,
        rejectionReason,
        generation: gen,
      });

      if (driveResult.kind === 'approval_required') {
        this.deps.statusMachine.requestApproval();
        yield toTerminalEvent(driveResult.result);
      } else if (driveResult.kind === 'fresh_start_required') {
        this.deps.statusMachine.complete();

        runnerCalled = true;
        this.deps.statusMachine.beginTurn();
        const it = this.deps.initialTurnRunner.run(
          { text: '' },
          {
            skipUserMessage: true,
            token: gen,
            retries: driveResult.retryCounts,
          },
        );
        let res = await it.next();
        while (!res.done) {
          yield res.value;
          res = await it.next();
        }
        runnerOutcome = res.value;
        if (
          runnerOutcome &&
          (runnerOutcome.kind === 'response' ||
            runnerOutcome.kind === 'approval_required' ||
            runnerOutcome.kind === 'stale')
        ) {
          if (runnerOutcome.terminal) {
            yield toTerminalEvent(runnerOutcome.terminal);
          }
        }
      } else if (driveResult.kind === 'stale') {
        // stale - do nothing
      } else {
        yield toTerminalEvent(driveResult.result);
      }
    } finally {
      if (runnerCalled) {
        if (runnerOutcome && runnerOutcome.kind === 'approval_required') {
          this.deps.statusMachine.requestApproval();
        } else if (runnerOutcome && runnerOutcome.kind === 'stale') {
          // stale leaves status untouched
        } else {
          this.deps.statusMachine.complete();
        }
      } else {
        this.deps.statusMachine.complete();
      }
    }
  }

  abort(): void {
    this.deps.approvalFlow.abort();
    this.deps.statusMachine.abort();
  }
}
