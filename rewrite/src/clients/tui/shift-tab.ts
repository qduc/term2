import { useRef } from 'react';
import type { Key } from 'ink';

/** Shift+Tab arrives as a modified Tab or, on terminals Ink does not decode, as the raw `ESC [ Z` sequence. */
export const isShiftTab = (input: string, key: Key): boolean => (key.shift && key.tab) || input === '\x1b[Z';

/** Cycles the approval mode through `/auto-approve next`; a second press while one is in flight is ignored. */
export function useApprovalCycle(setNotice: (text: string | null) => void, run: () => Promise<{ message?: string }>) {
  const pending = useRef(false);
  return () => {
    if (pending.current) return;
    pending.current = true;
    void run()
      .then(
        (result) => setNotice(result.message ?? 'Approval mode changed.'),
        (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        pending.current = false;
      });
  };
}
