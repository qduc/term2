import { useState } from 'react';
import type { Key } from 'ink';
import type { QueueItem, TuiState } from './state.js';
import type { TuiConnection } from './integration.js';
import { queueAction } from './commands.js';

/**
 * Legacy InputBox's pending-queue selection: Up on an empty composer selects the newest queued message;
 * Up/Down move, `e` or Enter edits, `d` retracts, Escape leaves the list, and Up past the oldest returns
 * to history.
 */
export function useQueueSelection(
  state: TuiState,
  connection: TuiConnection,
  actions: { readonly edit: (item: QueueItem) => void; readonly historyUp: () => void },
) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const items = ['steering', 'queued'].flatMap((delivery) => state.queue.filter((item) => item.delivery === delivery));
  const index = items.findIndex((item) => item.id === selectedId);
  return {
    items,
    index,
    selectedId: index < 0 ? null : selectedId,
    notice,
    /** Up on an empty composer; true when it opened the list. */
    open(): boolean {
      if (!items.length) return false;
      setNotice(null);
      setSelectedId(items[items.length - 1]!.id);
      return true;
    },
    /** The editor's keys while a queued message is selected; true when consumed. */
    key(input: string, key: Key): boolean {
      if (index < 0) return false;
      const item = items[index]!;
      if (key.escape) setSelectedId(null);
      else if (key.upArrow) {
        if (index > 0) setSelectedId(items[index - 1]!.id);
        else {
          setSelectedId(null);
          actions.historyUp();
        }
      } else if (key.downArrow) setSelectedId(items[index + 1]?.id ?? null);
      else if (input === 'e' || key.return) {
        setSelectedId(null);
        setNotice(null);
        actions.edit(item);
      } else if (input === 'd') {
        setSelectedId(null);
        void queueAction(connection, 'retract', item.id).catch((error: unknown) =>
          setNotice(error instanceof Error ? error.message : String(error)),
        );
      }
      return true;
    },
  };
}
