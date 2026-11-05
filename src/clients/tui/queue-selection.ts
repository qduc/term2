import { useRef, useState } from 'react';
import type { Key } from 'ink';
import type { QueueItem, TuiState } from './state.js';
import type { TuiConnection } from './integration.js';
import { queueAction } from './commands.js';

/**
 * Legacy InputBox's pending-queue selection: Up on an empty composer selects the newest queued message;
 * Up/Down move, `e` or Enter edits, `d` retracts, Escape leaves the list, and Up past the oldest returns
 * to history. Like legacy's queueSelectionIndexRef, the selection is read from a ref: keys written back to back
 * (Up, Up, Up, e in one read) arrive before React re-renders, so `e` edits the message the burst selected.
 */
export function useQueueSelection(
  state: TuiState,
  connection: TuiConnection,
  actions: { readonly edit: (item: QueueItem) => void; readonly historyUp: () => void },
) {
  const [selectedId, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const setSelectedId = (id: string | null) => {
    selectedRef.current = id;
    setSelected(id);
  };
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
      const current = items.findIndex((item) => item.id === selectedRef.current);
      if (current < 0) return false;
      // Legacy's editor gate reads the rendered selection: an arrow that lands before the selection renders
      // reaches the editor, whose boundary arrow opens the list at the newest message again.
      if ((key.upArrow || key.downArrow) && index < 0) return false;
      const item = items[current]!;
      if (key.escape) setSelectedId(null);
      else if (key.upArrow) {
        if (current > 0) setSelectedId(items[current - 1]!.id);
        else {
          setSelectedId(null);
          actions.historyUp();
        }
      } else if (key.downArrow) setSelectedId(items[current + 1]?.id ?? null);
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
