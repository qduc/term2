import type { ConversationTerminal } from '../../contracts/conversation.js';
import type { AbortedApprovalContext } from '../approval/approval-state.js';
import type { RetryCounts } from '../retry/retry-contracts.js';

// ── Types ──────────────────────────────────────────────────────

export type TurnState = 'idle' | 'streaming' | 'awaiting_approval' | 'continuing';

export type TurnOutcome =
  | { kind: 'response'; terminal: ConversationTerminal }
  | { kind: 'approval_required'; terminal: ConversationTerminal }
  | { kind: 'stale' }
  | { kind: 'failed' }
  | { kind: 'fresh_start_required'; retryCounts: RetryCounts; delayMs?: number; useStandardServiceTier?: boolean }
  | {
      kind: 'abort_resolution_required';
      abortedContext: AbortedApprovalContext;
      userText: string;
      generation: number;
    }
  | {
      kind: 'auto_approval_required';
      generation: number;
      callId?: string;
      command?: string;
    };

export type TurnCommand =
  | { kind: 'emit_terminal'; terminal: ConversationTerminal }
  | {
      kind: 're_drive';
      options: { skipUserMessage: true; retries: RetryCounts; delayMs?: number; useStandardServiceTier?: boolean };
    }
  | { kind: 'none' };

export interface TurnTransition {
  next: TurnState;
  command: TurnCommand;
}

const assertNever = (value: never): never => {
  throw new Error(`Unhandled turn outcome: ${JSON.stringify(value)}`);
};

// ── Transition function ────────────────────────────────────────

/**
 * Pure function that determines the next turn state and command
 * given the current state and the outcome of a turn attempt.
 *
 * Throws on invalid state/outcome combinations (e.g. outcomes
 * received while in `idle` or `awaiting_approval`).
 */
export function decideTurnTransition(current: TurnState, outcome: TurnOutcome): TurnTransition {
  if (outcome.kind === 'abort_resolution_required' || outcome.kind === 'auto_approval_required') {
    throw new Error(`Invalid transition: outcome ${outcome.kind} is not allowed in transition rules`);
  }
  switch (current) {
    case 'idle':
    case 'awaiting_approval':
      throw new Error(`Invalid transition from ${current}: received ${outcome.kind}`);

    case 'streaming': {
      switch (outcome.kind) {
        case 'response':
          return { next: 'idle', command: { kind: 'emit_terminal', terminal: outcome.terminal } };
        case 'approval_required':
          return { next: 'awaiting_approval', command: { kind: 'emit_terminal', terminal: outcome.terminal } };
        case 'stale':
          return { next: 'streaming', command: { kind: 'none' } };
        case 'failed':
          return { next: 'idle', command: { kind: 'none' } };
        case 'fresh_start_required':
          throw new Error('Invalid outcome fresh_start_required for state streaming');
        default:
          return assertNever(outcome);
      }
    }

    case 'continuing': {
      switch (outcome.kind) {
        case 'response':
          return { next: 'idle', command: { kind: 'emit_terminal', terminal: outcome.terminal } };
        case 'approval_required':
          return { next: 'awaiting_approval', command: { kind: 'emit_terminal', terminal: outcome.terminal } };
        case 'stale':
          return { next: 'continuing', command: { kind: 'none' } };
        case 'fresh_start_required':
          return {
            next: 'streaming',
            command: {
              kind: 're_drive',
              options: {
                skipUserMessage: true,
                retries: outcome.retryCounts,
                delayMs: outcome.delayMs,
                useStandardServiceTier: outcome.useStandardServiceTier,
              },
            },
          };
        case 'failed':
          throw new Error('Invalid outcome failed for state continuing');
        default:
          return assertNever(outcome);
      }
    }
    default:
      return assertNever(current);
  }
}
