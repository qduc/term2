import { useEffect, useState } from 'react';
import { calculateInputWidth } from '../components/input/input-width.js';
const RESIZE_DEBOUNCE_MS = 120;
export const useTerminalWidth = ({ waitingForRejectionReason, isShellMode, promptLabel }) => {
    const [terminalWidth, setTerminalWidth] = useState(0);
    useEffect(() => {
        const compute = () => calculateInputWidth({
            terminalColumns: process.stdout.columns,
            waitingForRejectionReason,
            isShellMode,
            promptLabel,
        });
        setTerminalWidth(compute()); // eslint-disable-line react-hooks/set-state-in-effect
        let resizeTimeout = null;
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
    }, [waitingForRejectionReason, isShellMode, promptLabel]);
    return terminalWidth;
};
//# sourceMappingURL=use-terminal-width.js.map