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
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return size;
}
