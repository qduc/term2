import { useState, useCallback } from 'react';
import { HistoryService } from '../services/history-service.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';

/**
 * Hook for managing input history navigation with up/down arrows.
 *
 * Usage:
 * - Press up arrow to navigate to previous messages
 * - Press down arrow to navigate to next messages
 * - At the end (down from most recent), returns to current input
 */
export const useInputHistory = (historyService: HistoryService) => {
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [currentInput, setCurrentInput] = useState<UserTurn>({ text: '' });

  const normalizeDraft = useCallback((value: string | UserTurn): UserTurn => normalizeUserTurn(value), []);

  /**
   * Navigate to previous message in history (up arrow)
   */
  const navigateUp = useCallback(
    (currentValue: string | UserTurn): UserTurn | null => {
      const messages = historyService.getTurns();

      if (messages.length === 0) {
        return null;
      }

      // If we're at the bottom (editing current input), save it
      if (historyIndex === -1) {
        setCurrentInput(normalizeDraft(currentValue));
      }

      // Calculate new index
      const newIndex = historyIndex === -1 ? messages.length - 1 : Math.max(0, historyIndex - 1);

      setHistoryIndex(newIndex);
      return messages[newIndex] ?? null;
    },
    [historyIndex, historyService, normalizeDraft],
  );

  /**
   * Navigate to next message in history (down arrow)
   */
  const navigateDown = useCallback((): UserTurn | null => {
    const messages = historyService.getTurns();

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
  }, [historyIndex, currentInput, historyService]);

  /**
   * Reset history navigation (call when input is submitted or cleared)
   */
  const reset = useCallback(() => {
    setHistoryIndex(-1);
    setCurrentInput({ text: '' });
  }, []);

  /**
   * Add a message to history
   */
  const addToHistory = useCallback(
    (message: string | UserTurn) => {
      historyService.addMessage(message);
      reset();
    },
    [historyService, reset],
  );

  return {
    navigateUp,
    navigateDown,
    reset,
    addToHistory,
  };
};
