import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import { builtinProfiles } from '../services/profiles/registry.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { resolveActiveProfile } from '../services/profiles/active-profile.js';

export { PROFILE_TRIGGER } from '../components/input/triggers.js';

export type ProfileOption = {
  /** Canonical id, e.g. `builtin:lite`. */
  id: string;
  /** Short id accepted by `/profile`, e.g. `lite`. */
  shortId: string;
  displayName: string;
  detail: string;
};

const PROFILE_DETAILS: Record<string, string> = {
  standard: 'Default full-context mode',
  lite: 'Minimal prompt, no codebase context',
  plan: 'Read-only research/planning mode',
  mentor: 'Collaborative mode with mentor model',
  orchestrator: 'Delegate all tool-backed work',
};

export const PROFILE_OPTIONS: readonly ProfileOption[] = builtinProfiles.map((profile) => {
  const shortId = profile.id.includes(':') ? profile.id.split(':').at(-1)! : profile.id;
  return {
    id: `builtin:${shortId}`,
    shortId,
    displayName: profile.name,
    detail: PROFILE_DETAILS[shortId] ?? '',
  };
});

/** Case-insensitive match over short id and display name. */
export const filterProfiles = (profiles: readonly ProfileOption[], query: string): ProfileOption[] => {
  if (!query) return [...profiles];
  const lowerQuery = query.toLowerCase();
  return profiles.filter(
    (p) => p.shortId.toLowerCase().includes(lowerQuery) || p.displayName.toLowerCase().includes(lowerQuery),
  );
};

export const useProfileSelection = (deps: { settingsService: SettingsService }) => {
  const { settingsService } = deps;
  const { mode, input, cursorOffset, triggerIndex, controller } = useInputContext();

  const controllerFrame = controller.getSnapshot().stack.at(-1);
  const isControllerOpen = controllerFrame?.kind === 'profile';
  const isOpen = isControllerOpen || mode === 'profile_selection';
  const activeTriggerIndex = isControllerOpen ? controllerFrame.binding.replacement.start : triggerIndex;

  const activeProfileId = useMemo(() => {
    if (!isOpen) return null;
    try {
      return resolveActiveProfile(settingsService).identity.id;
    } catch {
      return null;
    }
  }, [isOpen, settingsService]);

  const query = useMemo(() => {
    if (!isOpen) return '';
    if (isControllerOpen) return controllerFrame.binding.query;
    if (triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, isControllerOpen, controllerFrame, triggerIndex, input, cursorOffset]);

  const filteredProfiles = useMemo(() => filterProfiles(PROFILE_OPTIONS, query), [query]);

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
