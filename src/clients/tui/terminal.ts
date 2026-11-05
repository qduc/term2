import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/** Track the active Ink output stream, not the process-global stdout. */
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const measure = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [size, setSize] = useState(measure);
  useEffect(() => {
    const onResize = () => setSize(measure());
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

/** Match the legacy CLI's clear-and-redraw policy without importing its app layer. */
export const TERMINAL_REDRAW_CLEAR = '\u001B[2J\u001B[3J\u001B[H';
export function clearTerminalForRedraw(stdout: { write: (text: string) => unknown }): void {
  stdout.write(TERMINAL_REDRAW_CLEAR);
}

/** Resize clears only the visible screen, leaving terminal scrollback intact. */
export function clearVisibleForResize(stdout: { write: (text: string) => unknown }): void {
  stdout.write('\u001B[2J\u001B[H');
}
