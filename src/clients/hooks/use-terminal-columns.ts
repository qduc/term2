import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

const RESIZE_DEBOUNCE_MS = 120;

/**
 * Returns the terminal's current column count, updating on resize.
 *
 * This exists because Ink's own resize handling bypasses React: on a
 * terminal resize Ink recomputes Yoga layout and re-emits the *existing*
 * React output, but it does not schedule a React re-render. A component
 * that derives its output from `stdout.columns` (reading it directly, as
 * `StatusBar` and `MessageList` do) therefore keeps rendering against a
 * stale width until some unrelated state change happens to re-render it.
 * Subscribing to the stdout stream's `resize` event here forces a React
 * state update, so any component that calls this hook re-renders with the
 * new width when the terminal is resized.
 */
export const useTerminalColumns = (): number => {
  const { stdout } = useStdout();
  // Start from the current column count (not 0) so the first paint is
  // correct — a 0 width would make width-sensitive layouts like StatusBar
  // drop everything for one frame before the effect below runs.
  const [columns, setColumns] = useState(() => stdout.columns ?? 80);

  useEffect(() => {
    setColumns(stdout.columns ?? 80); // eslint-disable-line react-hooks/set-state-in-effect

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        setColumns(stdout.columns ?? 80);
      }, RESIZE_DEBOUNCE_MS);
    };

    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
    };
  }, [stdout]);

  return columns;
};
