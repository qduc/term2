/** Transcript edits are proposals; only Session may commit them. */
import type { Item, ItemId } from '../model/index.js';

export type DirectHistoryEdit =
  | { readonly kind: 'unavailable'; readonly reason: 'no_anchor' | 'unsettled_tools' | 'incomplete_tool_round' }
  | {
      readonly kind: 'replace';
      readonly history: readonly Item[];
      readonly removed: readonly Item[];
      readonly anchor: ItemId;
      readonly disableChaining: true;
    };

/**
 * Retry-turn regenerates the latest genuine user turn, even if it completed.
 * Retry-tool keeps the last tool output itself and removes only later items;
 * neither operation executes a tool or rolls back physical effects. Session
 * must retain execution audit facts independently of the edited transcript.
 */
export function prepareDirectHistoryRetry(input: {
  readonly history: readonly Item[];
  readonly target: 'turn' | 'tool';
  readonly executionsSettled: boolean;
}): DirectHistoryEdit {
  if (!input.executionsSettled) return { kind: 'unavailable', reason: 'unsettled_tools' };
  const type = input.target === 'turn' ? 'user_message' : 'tool_result';
  for (let index = input.history.length - 1; index >= 0; index--) {
    if (input.history[index]!.type === type) return editAfter(input.history, index);
  }
  return { kind: 'unavailable', reason: 'no_anchor' };
}

/** Rewind to an existing inclusive ItemId; no file restore or tool execution. */
export function prepareDirectHistoryRewind(input: {
  readonly history: readonly Item[];
  readonly anchor: ItemId;
  readonly executionsSettled: boolean;
}): DirectHistoryEdit {
  if (!input.executionsSettled) return { kind: 'unavailable', reason: 'unsettled_tools' };
  return editAfter(
    input.history,
    input.history.findIndex((item) => item.id === input.anchor),
  );
}

function editAfter(history: readonly Item[], index: number): DirectHistoryEdit {
  if (index < 0) return { kind: 'unavailable', reason: 'no_anchor' };
  const retained = history.slice(0, index + 1);
  if (!hasCompleteDirectToolPairs(retained)) return { kind: 'unavailable', reason: 'incomplete_tool_round' };
  return {
    kind: 'replace',
    history: retained,
    removed: history.slice(index + 1),
    anchor: history[index]!.id,
    disableChaining: true,
  };
}

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
