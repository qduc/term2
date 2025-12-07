import {useState, useCallback} from 'react';
import {historyService} from '../services/history-service.js';

/**
 * Hook for managing input history navigation with up/down arrows.
 *
 * Usage:
 * - Press up arrow to navigate to previous messages
 * - Press down arrow to navigate to next messages
 * - At the end (down from most recent), returns to current input
 */
export const useInputHistory = () => {
    const [historyIndex, setHistoryIndex] = useState<number>(-1);
    const [currentInput, setCurrentInput] = useState<string>('');

    /**
     * Navigate to previous message in history (up arrow)
     */
    const navigateUp = useCallback(
        (currentValue: string): string | null => {
            const messages = historyService.getMessages();

            if (messages.length === 0) {
                return null;
            }

            // If we're at the bottom (editing current input), save it
            if (historyIndex === -1) {
                setCurrentInput(currentValue);
            }

            // Calculate new index
            const newIndex =
                historyIndex === -1
                    ? messages.length - 1
                    : Math.max(0, historyIndex - 1);

            setHistoryIndex(newIndex);
            return messages[newIndex] ?? null;
        },
        [historyIndex],
    );

    /**
     * Navigate to next message in history (down arrow)
     */
    const navigateDown = useCallback((): string | null => {
        const messages = historyService.getMessages();

        if (historyIndex === -1) {
            // Already at the bottom
            return null;
        }

        const newIndex = historyIndex + 1;

        if (newIndex >= messages.length) {
            // Reached the end, return to current input
            setHistoryIndex(-1);
            return currentInput;
        }

        setHistoryIndex(newIndex);
        return messages[newIndex] ?? null;
    }, [historyIndex, currentInput]);

    /**
     * Reset history navigation (call when input is submitted or cleared)
     */
    const reset = useCallback(() => {
        setHistoryIndex(-1);
        setCurrentInput('');
    }, []);

    /**
     * Add a message to history
     */
    const addToHistory = useCallback(
        (message: string) => {
            historyService.addMessage(message);
            reset();
        },
        [reset],
    );

    return {
        navigateUp,
        navigateDown,
        reset,
        addToHistory,
    };
};
