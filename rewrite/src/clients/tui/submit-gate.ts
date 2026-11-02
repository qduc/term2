import { useMemo, useRef } from 'react';

/**
 * The in-flight flag for session sends. Behaves like a ref (`gate.current`), but a send that arrives while
 * another is in flight is deferred and run when the flag clears, instead of being dropped: the composer was
 * already emptied for it, so dropping would lose the message.
 */
export function useSubmitGate() {
  const busy = useRef(false);
  const waiting = useRef<Array<() => void>>([]);
  return useMemo(
    () => ({
      get current() {
        return busy.current;
      },
      set current(value: boolean) {
        busy.current = value;
        // After the finishing send has reset its own state, start the next one.
        if (!value) queueMicrotask(() => waiting.current.shift()?.());
      },
      defer(run: () => void) {
        waiting.current.push(run);
      },
    }),
    [],
  );
}
