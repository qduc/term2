import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import type { SkillsService } from '../services/skills/skills-service.js';

export { SKILLS_TRIGGER } from '../components/input/triggers.js';

export const useSkillSelection = (deps: { skillsService: SkillsService }) => {
  const { skillsService } = deps;
  const { mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex } = useInputContext();

  const isOpen = mode === 'skill_selection';

  const allSkills = useMemo(() => skillsService.getAvailableSkills(), [skillsService, isOpen]);

  const query = useMemo(() => {
    if (!isOpen || triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, triggerIndex, input, cursorOffset]);

  const filteredSkills = useMemo(() => {
    if (!query) return allSkills;
    const lowerQuery = query.toLowerCase();
    return allSkills.filter(
      (s) => s.name.toLowerCase().includes(lowerQuery) || s.description.toLowerCase().includes(lowerQuery),
    );
  }, [allSkills, query]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredSkills);

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
      if (mode === 'skill_selection') return;
      setMode('skill_selection');
      setTriggerIndex(startIndex);
      setSelectedIndex(0);
    },
    [mode, setMode, setTriggerIndex, setSelectedIndex],
  );

  const close = useCallback(() => {
    if (mode === 'skill_selection') {
      setMode('text');
      setTriggerIndex(null);
    }
  }, [mode, setMode, setTriggerIndex]);

  return {
    isOpen,
    open,
    close,
    query,
    triggerIndex,
    skills: filteredSkills,
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
