/** Tool call/result pairing checks for recovery and history edits. */
import type { Item } from '../model/index.js';

/** Check occurrence-local call/result pairing without assuming globally unique provider ids. */
export function hasCompleteDirectToolPairs(history: readonly Item[]): boolean {
  const pending: string[] = [];
  for (const item of history) {
    if (item.type === 'tool_call') pending.push(item.callId);
    if (item.type === 'tool_result') {
      const index = pending.indexOf(item.callId);
      if (index < 0) return false;
      pending.splice(index, 1);
    }
  }
  return pending.length === 0;
}
