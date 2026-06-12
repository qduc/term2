import { useEffect, useState } from 'react';
import { calculateInputWidth } from '../components/input/input-width.js';

type Options = {
  waitingForRejectionReason: boolean;
  isShellMode: boolean;
  promptLabel?: string;
};

const RESIZE_DEBOUNCE_MS = 120;

export const useTerminalWidth = ({ waitingForRejectionReason, isShellMode, promptLabel }: Options): number => {
  const [terminalWidth, setTerminalWidth] = useState(0);

  useEffect(() => {
    const compute = () =>
      calculateInputWidth({
        terminalColumns: process.stdout.columns,
        waitingForRejectionReason,
        isShellMode,
        promptLabel,
      });

    setTerminalWidth(compute());

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        setTerminalWidth(compute());
      }, RESIZE_DEBOUNCE_MS);
    };

    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
    };
  }, [waitingForRejectionReason, isShellMode]);

  return terminalWidth;
};
