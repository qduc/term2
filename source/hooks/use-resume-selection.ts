import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import type { ConversationListEntry } from '../services/conversation/conversation-persistence.js';

export { RESUME_TRIGGER } from '../components/input/triggers.js';

export const useResumeSelection = (deps: { listConversations: () => ConversationListEntry[] }) => {
  const { listConversations } = deps;
  const { mode, input, cursorOffset, triggerIndex, controller } = useInputContext();

  const controllerFrame = controller.getSnapshot().stack.at(-1);
  const isControllerOpen = controllerFrame?.kind === 'resume';
  const isOpen = isControllerOpen || mode === 'resume_selection';
  const activeTriggerIndex = isControllerOpen ? controllerFrame.binding.replacement.start : triggerIndex;

  const allConversations = useMemo(() => (isOpen ? listConversations() : []), [listConversations, isOpen]);

  const query = useMemo(() => {
    if (!isOpen) return '';
    if (isControllerOpen) return controllerFrame.binding.query;
    if (triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, isControllerOpen, controllerFrame, triggerIndex, input, cursorOffset]);

  const filteredConversations = useMemo(() => {
    if (!query) return allConversations;
    const lowerQuery = query.toLowerCase();
    return allConversations.filter(
      (c) =>
        c.id.toLowerCase().includes(lowerQuery) ||
        (c.firstUserMessage && c.firstUserMessage.toLowerCase().includes(lowerQuery)) ||
        (c.model && c.model.toLowerCase().includes(lowerQuery)) ||
        (c.sshHost && c.sshHost.toLowerCase().includes(lowerQuery)),
    );
  }, [allConversations, query]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredConversations);

  const MAX_VISIBLE_ITEMS = 10;
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    setScrollOffset(0);
  }, [query]);

  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + MAX_VISIBLE_ITEMS) {
      setScrollOffset(selectedIndex - MAX_VISIBLE_ITEMS + 1);
    }
  }, [selectedIndex, scrollOffset]);

  const open = useCallback(
    (startIndex: number) => {
      if (mode === 'resume_selection') return;
      const editor = controller.getSnapshot().editor;
      controller.replaceText(editor.text, Math.max(editor.cursor, startIndex));
      setSelectedIndex(0);
    },
    [mode, controller, setSelectedIndex],
  );

  const close = useCallback(() => {
    if (mode === 'resume_selection') {
      controller.close();
    }
  }, [mode, controller]);

  return {
    isOpen,
    open,
    close,
    query,
    triggerIndex: activeTriggerIndex,
    conversations: filteredConversations,
    selectedIndex,
    scrollOffset,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    getSelectedItem,
  };
};
