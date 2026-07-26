import type { RewindTarget } from '../../services/conversation/conversation-store.js';
import type { RewindItem } from '../../hooks/use-rewind-selection.js';

/**
 * Join the rendered user messages with the store's discard statistics.
 *
 * Turn numbers come from the UI message list because that is the list
 * `ConversationOrchestrator.rewindToTurn` resolves a turn number against — the
 * picker must not invent a second numbering. Statistics come from the store,
 * which is the only place that can see assistant replies and tool calls.
 *
 * The two lists are aligned from the newest turn backwards: the store can be
 * trimmed independently of the rendered transcript, and it is the recent turns
 * whose costs a user is deciding about. A turn with no counterpart is reported
 * as discarding only itself rather than guessing.
 */
export function buildRewindItems(
  userMessages: readonly { uiIndex: number; text: string }[],
  storeTargets: readonly RewindTarget[],
): RewindItem[] {
  const offset = storeTargets.length - userMessages.length;

  return userMessages.map((message, position) => {
    const stats = storeTargets[position + offset];

    return {
      turnNumber: position + 1,
      text: message.text,
      imageCount: stats?.imageCount ?? 0,
      discardedTurns: stats?.discardedTurns ?? 1,
      discardedReplies: stats?.discardedReplies ?? 0,
      discardedFiles: stats?.discardedFiles ?? [],
    };
  });
}
