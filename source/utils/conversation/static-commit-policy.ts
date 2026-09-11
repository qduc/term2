import type { BotMessage, CommandMessage, ReasoningMessage, SubagentActivityMessage } from '../../types/message.js';

/**
 * Single source of truth for which message rows can enter Ink's <Static>
 * region. Both the renderer (MessageList's history/active split and the
 * static-commit-blocker warning) and the conversation orchestrator's
 * end-of-turn settlement consume this module, so a new Message variant or
 * status is classified once — an unclassified addition is a type error here,
 * not a silently stranded row that blocks static commit for the rest of the
 * session.
 *
 * The subject is a structural subset of the Message union so tests and the
 * renderer's looser MessageLike rows can be classified without carrying every
 * display field.
 */
export type StaticCommitSubject =
  | Pick<BotMessage, 'sender' | 'status'>
  | Pick<CommandMessage, 'sender' | 'status'>
  | Pick<ReasoningMessage, 'sender' | 'status'>
  | Pick<SubagentActivityMessage, 'sender' | 'status'>
  | { sender: 'user' }
  | { sender: 'system' }
  // Produced by concise-mode grouping over settled command rows; always
  // committable by construction.
  | { sender: 'command-group' };

/** Why a row cannot be committed into <Static>. `null` means committable. */
export type StaticCommitBlockerReason =
  | 'bot_streaming'
  | 'reasoning_streaming'
  | 'command_pending'
  | 'command_running'
  | 'subagent_activity';

// Exhaustiveness below uses `value satisfies never` in default branches: if
// the union grows, the default-branch value is no longer `never` and this
// fails to compile until the new member is classified. Unlike a throwing
// assertNever it is also runtime-safe — the renderer feeds rows whose loose
// MessageLike types could in principle carry an unrecognized string, and an
// unrecognized row must degrade to "committable" (the pre-policy behavior),
// never crash the render loop.

export function classifyStaticCommitBlocker(message: StaticCommitSubject): StaticCommitBlockerReason | null {
  switch (message.sender) {
    case 'bot':
      return message.status === 'streaming' ? 'bot_streaming' : null;
    case 'reasoning':
      // No status yet means the live row exists but has not been finalized —
      // it still blocks.
      return message.status === 'finalized' ? null : 'reasoning_streaming';
    case 'command': {
      const status = message.status;
      switch (status) {
        case 'pending':
          return 'command_pending';
        case 'running':
          return 'command_running';
        case 'completed':
        case 'failed':
        case 'aborted':
          return null;
        default:
          status satisfies never;
          return null;
      }
    }
    case 'subagent': {
      const status = message.status;
      switch (status) {
        case 'running':
          return 'subagent_activity';
        case 'completed':
        case 'failed':
        case 'cancelled':
        case 'interrupted':
        case 'backgrounded':
          return null;
        default:
          status satisfies never;
          return null;
      }
    }
    case 'user':
    case 'system':
    case 'command-group':
      return null;
    default:
      message satisfies never;
      return null;
  }
}

export const isBlockingStaticCommit = (message: StaticCommitSubject): boolean =>
  classifyStaticCommitBlocker(message) !== null;

/**
 * What a closing turn may do with a row that still blocks static commit.
 *
 * This is deliberately not the same question as "does it block": command rows
 * are settled by aborting them, turn-owned streaming rows by finalizing them,
 * and background subagent rows must be left alone — a running background
 * subagent legitimately outlives the turn, and freezing it into <Static>
 * irreversibly misrenders live work. Every blocking classification must name
 * its rule; that table is pinned by static-commit-policy.test.ts.
 */
export type TurnEndSettlement = 'finalize' | 'abort' | 'leave';

export function turnEndSettlement(reason: StaticCommitBlockerReason): TurnEndSettlement {
  switch (reason) {
    case 'bot_streaming':
    case 'reasoning_streaming':
      return 'finalize';
    case 'command_pending':
    case 'command_running':
      return 'abort';
    case 'subagent_activity':
      return 'leave';
    default:
      reason satisfies never;
      // Unreachable for the known union. If it somehow runs, leaving the row
      // alone can only keep the tail rendering dynamically — it can never
      // freeze live work into <Static> irreversibly.
      return 'leave';
  }
}
