import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import type { SkillsService, SkillInfo } from '../services/skills/skills-service.js';

export { SKILLS_TRIGGER } from '../components/input/triggers.js';

/** Case-insensitive match over skill name and description. */
export const filterSkills = (skills: SkillInfo[], query: string): SkillInfo[] => {
  if (!query) return skills;
  const lowerQuery = query.toLowerCase();
  return skills.filter(
    (s) => s.name.toLowerCase().includes(lowerQuery) || s.description.toLowerCase().includes(lowerQuery),
  );
};

export const useSkillSelection = (deps: { skillsService: SkillsService }) => {
  const { skillsService } = deps;
  const { mode, input, cursorOffset, triggerIndex, controller } = useInputContext();

  const controllerFrame = controller.getSnapshot().stack.at(-1);
  const isControllerOpen = controllerFrame?.kind === 'skills';
  const isOpen = isControllerOpen || mode === 'skill_selection';
  const activeTriggerIndex = isControllerOpen ? controllerFrame.binding.replacement.start : triggerIndex;

  const allSkills = useMemo(() => skillsService.getAvailableSkills(), [skillsService]);

  const query = useMemo(() => {
    if (!isOpen) return '';
    if (isControllerOpen) return controllerFrame.binding.query;
    if (triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, isControllerOpen, controllerFrame, triggerIndex, input, cursorOffset]);

  const filteredSkills = useMemo(() => filterSkills(allSkills, query), [allSkills, query]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredSkills);

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
      if (mode === 'skill_selection') return;
      const editor = controller.getSnapshot().editor;
      controller.replaceText(editor.text, Math.max(editor.cursor, startIndex));
      setSelectedIndex(0);
    },
    [mode, controller, setSelectedIndex],
  );

  const close = useCallback(() => {
    if (mode === 'skill_selection') {
      controller.close();
    }
  }, [mode, controller]);

  return {
    isOpen,
    open,
    close,
    query,
    triggerIndex: activeTriggerIndex,
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
