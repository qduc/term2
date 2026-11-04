import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from './input-context.js';
import { useSelection } from './use-selection.js';
import type { MenuProfileOption as ProfileOption } from '../integration.js';

export { PROFILE_TRIGGER } from './triggers.js';
export type { ProfileOption };

/** Case-insensitive match over short id and display name. */
export const filterProfiles = (
  profiles: readonly ProfileOption[],
  query: string,
  canonicalProfileId: (id: string) => string,
): ProfileOption[] => {
  if (!query) return [...profiles];
  const lowerQuery = query.toLowerCase();
  // Typed retired names select Bare without putting retired entries in the picker.
  const requestedId = lowerQuery.includes(':') ? lowerQuery : `builtin:${lowerQuery}`;
  const canonicalId = canonicalProfileId(requestedId);
  if (canonicalId !== requestedId) return profiles.filter((p) => p.id === canonicalId);
  return profiles.filter(
    (p) => p.shortId.toLowerCase().includes(lowerQuery) || p.displayName.toLowerCase().includes(lowerQuery),
  );
};

export const useProfileSelection = () => {
  const { mode, input, cursorOffset, triggerIndex, controller, menus, sessionId } = useInputContext();
  const profileMenu = menus.profile!;

  const controllerFrame = controller.getSnapshot().stack.at(-1);
  const isControllerOpen = controllerFrame?.kind === 'profile';
  const isOpen = isControllerOpen || mode === 'profile_selection';
  const activeTriggerIndex = isControllerOpen ? controllerFrame.binding.replacement.start : triggerIndex;

  const activeProfileId = useMemo(() => {
    if (!isOpen) return null;
    try {
      return profileMenu.activeId(sessionId); // resolveActiveProfile(settingsService).identity.id
    } catch {
      return null;
    }
  }, [isOpen, profileMenu, sessionId]);

  const query = useMemo(() => {
    if (!isOpen) return '';
    if (isControllerOpen) return controllerFrame.binding.query;
    if (triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, isControllerOpen, controllerFrame, triggerIndex, input, cursorOffset]);

  const filteredProfiles = useMemo(
    () => filterProfiles(profileMenu.options, query, profileMenu.canonicalId),
    [profileMenu, query],
  );

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredProfiles);

  const MAX_VISIBLE_ITEMS = 10;
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    setScrollOffset(0); // eslint-disable-line react-hooks/set-state-in-effect
  }, [query]);

  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex); // eslint-disable-line react-hooks/set-state-in-effect
    } else if (selectedIndex >= scrollOffset + MAX_VISIBLE_ITEMS) {
      setScrollOffset(selectedIndex - MAX_VISIBLE_ITEMS + 1);
    }
  }, [selectedIndex, scrollOffset]);

  const open = useCallback(
    (startIndex: number) => {
      if (mode === 'profile_selection') return;
      const editor = controller.getSnapshot().editor;
      controller.replaceText(editor.text, Math.max(editor.cursor, startIndex));
      setSelectedIndex(0);
    },
    [mode, controller, setSelectedIndex],
  );

  const close = useCallback(() => {
    if (mode === 'profile_selection') {
      controller.close();
    }
  }, [mode, controller]);

  return {
    isOpen,
    open,
    close,
    query,
    triggerIndex: activeTriggerIndex,
    profiles: filteredProfiles,
    activeProfileId,
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
