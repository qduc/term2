import { useEffect, useRef, useState } from 'react';

/**
 * Trailing-edge debounce for a value that changes faster than its consumer can
 * afford to react.
 *
 * Use this to keep expensive derived state off a keystroke's critical path: the
 * returned value only catches up once `value` has been quiet for `delayMs`.
 *
 * `shouldFlush` escapes the delay for transitions that must be immediate — an
 * advisory computed from the composer, for example, has to disappear the
 * instant the composer is cleared, not a debounce interval later.
 */
export function useDebouncedValue<T>(value: T, delayMs: number, shouldFlush?: (value: T) => boolean): T {
  const [debounced, setDebounced] = useState(value);
  const shouldFlushRef = useRef(shouldFlush);
  shouldFlushRef.current = shouldFlush;

  useEffect(() => {
    if (shouldFlushRef.current?.(value)) {
      setDebounced(value);
      return;
    }

    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
