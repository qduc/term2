import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import { ShellAutoApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { InitialTurnRunOptions } from './turn-attempt-factory.js';
import type { InitialTurnRunner } from './initial-turn-runner.js';
import type { ContinuationDriver } from './continuation-driver.js';
import { decideTurnTransition, type TurnOutcome } from './turn-transition.js';

export interface ApprovalContinuationInput {
  answer: string;
  rejectionReason?: string;
  generation: number;
}

export interface TurnExecutor {
  executeInitial(
    input: string | UserTurn,
    options: InitialTurnRunOptions,
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void>;

  executeContinuation(input: ApprovalContinuationInput): AsyncGenerator<ConversationEvent, TurnOutcome, void>;
}

export interface DefaultTurnExecutorDeps {
  initialTurnRunner: InitialTurnRunner;
  continuationDriver: ContinuationDriver;
  shellAutoApproval: ShellAutoApprovalResolver;
}

export class DefaultTurnExecutor implements TurnExecutor {
  constructor(private readonly deps: DefaultTurnExecutorDeps) {}

  async *executeInitial(
    input: string | UserTurn,
    options: InitialTurnRunOptions = {},
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    let currentInput = input;
    let currentOptions = options;

    while (true) {
      const initialOutcome = yield* this.deps.initialTurnRunner.run(currentInput, currentOptions);

      if (initialOutcome.kind !== 'abort_resolution_required' && initialOutcome.kind !== 'auto_approval_required') {
        return initialOutcome;
      }

      const generation = initialOutcome.generation;
      let driveResult: TurnOutcome;
      if (initialOutcome.kind === 'abort_resolution_required') {
        driveResult = yield* this.deps.continuationDriver.drive(
          {
            kind: 'abort_resolution',
            abortedContext: initialOutcome.abortedContext,
            userText: initialOutcome.userText,
            generation,
          },
          new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
        );
      } else {
        driveResult = yield* this.deps.continuationDriver.drive(
          {
            kind: 'approval_decision',
            answer: 'y',
            generation,
          },
          new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
        );
      }

      if (driveResult.kind !== 'fresh_start_required') {
        return driveResult;
      }

      const transition = decideTurnTransition('continuing', driveResult);
      if (transition.command.kind !== 're_drive') {
        throw new Error(`Expected re_drive command, received ${transition.command.kind}`);
      }
      currentInput = { text: '' };
      currentOptions = {
        ...transition.command.options,
        token: generation,
        replayFromHistory: currentOptions.replayFromHistory,
      };
    }
  }

  async *executeContinuation({
    answer,
    rejectionReason,
    generation,
  }: ApprovalContinuationInput): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    const driveResult = yield* this.deps.continuationDriver.drive({
      kind: 'approval_decision',
      answer,
      rejectionReason,
      generation,
    });

    if (driveResult.kind !== 'fresh_start_required') {
      return driveResult;
    }

    const transition = decideTurnTransition('continuing', driveResult);
    if (transition.command.kind !== 're_drive') {
      throw new Error(`Expected re_drive command, received ${transition.command.kind}`);
    }

    return yield* this.executeInitial(
      { text: '' },
      {
        ...transition.command.options,
        token: generation,
      },
    );
  }
}
